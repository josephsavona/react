# Plan: `react_compiler_swc` — SWC Frontend for React Compiler

**Current status:** Phases 1-2 complete. All modules compile with 0 errors/warnings. Full pipeline wired up: SWC AST → react_compiler_ast → compile_program → reverse convert → SWC AST. 37 integration tests passing. Phase 3 (Wasm plugin) and Phase 4 (Differential testing) not started.

## Context

The Rust React Compiler (`compiler/crates/`) currently accepts Babel-format AST (`react_compiler_ast::File`) + scope info (`ScopeInfo`) and compiles via `compile_program()`. Two frontends exist or are planned:

1. **Babel NAPI bridge** (`compiler/packages/babel-plugin-react-compiler-rust/`) — production, crosses JS/NAPI boundary
2. **OXC frontend** (`compiler/crates/react_compiler_oxc/`) — pure Rust, Phases 1-3 complete

This plan adds an **SWC frontend** that enables React Compiler to run as an SWC plugin, integrating with SWC-based toolchains (Next.js, Parcel, custom SWC setups). Unlike OXC which provides a library API, SWC integration is primarily about the **plugin system** — SWC plugins receive a pre-parsed AST and must return a transformed AST.

## Key Differences from OXC Integration

| Aspect | OXC | SWC |
|--------|-----|-----|
| **AST format** | Arena-allocated (`oxc_allocator`), borrowed types | `swc_ecma_ast` — owned types, `#[derive(Clone)]` |
| **Scope/semantic** | `oxc_semantic` provides scope tree + symbol table | SWC has no built-in semantic analysis; must derive scope info from AST or use `swc_ecma_utils::ExprExt` / custom visitor |
| **Plugin model** | Library API — caller controls parse/transform | Wasm plugin (`swc_plugin_macro`) or native transform (`swc_ecma_visit::Fold/VisitMut`) |
| **Memory model** | Arena-based, zero-copy within arena | Owned/cloned types, `Box<T>` heavy |
| **Comments** | Separate `Comment` array from parser | Attached via `swc_common::comments::Comments` trait (leading/trailing per span) |
| **Source maps** | `oxc_span::Span` (byte offsets) | `swc_common::Span` (byte positions via `BytePos`) |
| **Distribution** | Linked as Rust crate | Wasm plugin (`.wasm`) for portability, or native for perf |

## Architecture Decision: Wasm Plugin vs Native Transform

SWC supports two integration modes:

### Option A: Wasm Plugin (Recommended for distribution)
- Compiled to `wasm32-wasip1` via `swc_core::plugin`
- Portable, works with any SWC host (Next.js, `@swc/cli`, Parcel)
- Has Wasm overhead (~2-5x slower than native) and memory constraints
- Uses `swc_core::plugin::proxied::*` types (serialized across Wasm boundary)

### Option B: Native Transform (Recommended for performance)
- Linked directly into SWC as a Rust crate
- Uses `swc_ecma_visit::Fold` or `VisitMut` trait
- Best performance, but requires building SWC from source
- Suitable for custom toolchains or Next.js SWC integration

**Recommendation:** Implement as a native transform crate first (Option B), then add a thin Wasm plugin wrapper. The core conversion logic is shared; only the entry point differs.

## Crate Structure

```
compiler/crates/react_compiler_swc/
  Cargo.toml
  src/
    lib.rs              — Public API: transform(), SWC Fold/VisitMut impl
    prefilter.rs        — Quick check for React-like function names in SWC AST
    convert_ast.rs      — SWC AST → react_compiler_ast::File
    convert_ast_reverse.rs — react_compiler_ast → SWC AST (for applying results)
    convert_scope.rs    — SWC AST → ScopeInfo (custom scope analysis)
    diagnostics.rs      — CompileResult → SWC diagnostic conversion
    plugin.rs           — Wasm plugin entry point (behind feature flag)
```

### Dependencies (Cargo.toml)

```toml
[package]
name = "react_compiler_swc"
version = "0.1.0"
edition = "2024"

[dependencies]
react_compiler_ast = { path = "../react_compiler_ast" }
react_compiler = { path = "../react_compiler" }
react_compiler_diagnostics = { path = "../react_compiler_diagnostics" }
swc_core = { version = "17", features = ["ecma_ast", "ecma_visit", "common"] }
swc_ecma_ast = "7"
swc_ecma_visit = "4"
swc_common = { version = "5", features = ["sourcemap"] }
swc_ecma_utils = "4"
indexmap = { version = "2", features = ["serde"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
default = []
plugin = ["swc_core/plugin_transform_host_native"]

# For building as Wasm plugin:
# [target.'cfg(target_arch = "wasm32")'.dependencies]
# swc_core = { version = "17", features = ["plugin_transform"] }
```

> **Note:** SWC crate versions change frequently. Pin to the versions matching the target SWC release. Check `swc_core`'s re-exports to avoid version conflicts.

## Module Details

### 1. `prefilter.rs` — Quick React Function Check

Port of the OXC prefilter, adapted to SWC AST types.

```rust
use swc_ecma_ast::*;
use swc_ecma_visit::{Visit, VisitWith};

pub fn has_react_like_functions(module: &Module) -> bool
```

- Use `swc_ecma_visit::Visit` trait to walk the AST
- Check `FnDecl` names, `VarDeclarator` inits that are arrow/function expressions
- Skip class bodies
- Name check: `starts_with(uppercase)` or matches `use[A-Z0-9]`
- Return `true` on first match (early exit via custom control flow)

**Differences from OXC version:**
- SWC uses `Module` (not `Program`) as the top-level type for ESM
- SWC `Ident` has a `sym: Atom` field (interned string) instead of `name: &str`
- Pattern matching on `Expr::Arrow` / `Expr::Fn` instead of OXC's enum variants

### 2. `convert_scope.rs` — SWC AST → ScopeInfo

This is the **most significantly different** module compared to OXC. SWC does not provide a built-in semantic analysis pass like `oxc_semantic`. We must build scope information ourselves.

```rust
pub fn build_scope_info(module: &Module, comments: &dyn Comments) -> ScopeInfo
```

**Approach:** Implement a two-pass scope analysis visitor:

**Pass 1 — Scope tree construction:**
- Walk the AST with a `swc_ecma_visit::Visit` impl
- Maintain a scope stack
- Create new scopes at: `Module`, `Function`/`ArrowExpr`, `BlockStmt` (for let/const), `ForStmt`/`ForInStmt`/`ForOfStmt`, `CatchClause`
- Record bindings at their declaring scope:
  - `var` declarations → hoisted to function scope
  - `let`/`const` → block scope
  - Function declarations → function scope (hoisted)
  - Parameters → function scope
  - Import declarations → module scope
  - Catch clause params → catch scope

**Pass 2 — Reference resolution:**
- Walk the AST again, maintaining the scope stack
- For each `Ident` usage that is not a declaration, look up the binding by walking up the scope chain
- Build `reference_to_binding` map: `span.lo → BindingId`
- Also build `node_to_scope` map: `span.lo → ScopeId` for scope-creating nodes

**Key data:**
- `ScopeId` — sequential u32 assigned during construction
- `BindingId` — sequential u32 assigned per binding
- `node_to_scope` — maps node byte positions to scope IDs
- `reference_to_binding` — maps identifier byte positions to binding IDs
- Import metadata — extracted from `ImportDecl` nodes

**Alternative approach:** Consider using `swc_ecma_utils` scope analysis helpers if available, or integrating with `swc_ecma_transforms_base::resolver::resolver()` which adds scope marks to identifiers. The resolver marks each `Ident` with a unique `SyntaxContext` that disambiguates shadowed variables. We could:
1. Run the SWC resolver pass first
2. Collect all `Ident`s with their `SyntaxContext`
3. Group by `(name, SyntaxContext)` to identify bindings
4. Build `ScopeInfo` from the grouped data

This approach is simpler and more reliable than a custom scope analysis, since SWC's resolver is battle-tested.

**Key files:**
- Target types: `compiler/crates/react_compiler_ast/src/scope.rs`
- Reference impl: `compiler/packages/babel-plugin-react-compiler-rust/src/scope.ts`
- SWC resolver: `swc_ecma_transforms_base::resolver`

### 3. `convert_ast.rs` — SWC AST → react_compiler_ast::File

```rust
pub fn convert_module(
    module: &Module,
    source_text: &str,
    comments: &dyn Comments,
) -> react_compiler_ast::File
```

**Approach:** Recursive conversion, one function per AST category. SWC's owned types make this straightforward — we clone/convert field by field.

**ConvertCtx:** Holds:
- Line-offset table for `Position { line, column, index }` computation
- Reference to `Comments` for comment extraction
- Source text for extracting raw string values

**Key mappings:**

| SWC | react_compiler_ast |
|-----|-------------------|
| `Module` | `File` with `Program` body |
| `ModuleItem::Stmt(stmt)` | `Statement` variants |
| `ModuleItem::ModuleDecl(decl)` | `ImportDeclaration`, `ExportDeclaration`, etc. |
| `Expr` variants | `expressions::Expression` variants |
| `Pat` variants | `patterns::PatternLike` variants |
| `JSXElement/Fragment/etc` | `jsx::*` types |
| `TsType*` | `Option<Box<serde_json::Value>>` (opaque passthrough) |

**BaseNode construction:**
- `start = Some(span.lo.0)`, `end = Some(span.hi.0)`
- `loc` — computed via line-offset table binary search
- `leading_comments` / `trailing_comments` — from `Comments::get_leading(span.lo)` / `Comments::get_trailing(span.hi)`

**SWC-specific considerations:**
- SWC uses `Atom` for interned strings — call `.to_string()` or use `&*atom`
- SWC `Lit::Str` has `value: Atom` and `raw: Option<Atom>`
- SWC `Ident` has `span`, `sym`, `ctxt` (syntax context from resolver)
- SWC template literals: `Tpl { exprs, quasis }` maps to `TemplateLiteral`
- SWC separates `MemberExpr` (static) from `SuperPropExpr` — both map to `MemberExpression`
- SWC `OptChainExpr` wraps the base expression — must unwrap to produce `OptionalMemberExpression`/`OptionalCallExpression`
- SWC `Decl` is separate from `Stmt` — fold `Stmt::Decl(decl)` into the appropriate `Statement` variant (Babel style)

**Comments extraction:**
- SWC comments are accessed via the `Comments` trait: `get_leading(BytePos)`, `get_trailing(BytePos)`
- Convert `swc_common::comments::Comment { kind, span, text }` → `react_compiler_ast::common::Comment`
- `kind: CommentKind::Block` → `CommentBlock`, `CommentKind::Line` → `CommentLine`

### 4. `convert_ast_reverse.rs` — react_compiler_ast → SWC AST

Mirror of `convert_ast.rs`. Converts the compiled Babel-format AST back into SWC AST nodes.

```rust
pub fn convert_program_to_swc(
    file: &react_compiler_ast::File,
) -> (Module, SingleThreadedComments)
```

**Key differences from OXC reverse conversion:**
- SWC types are owned, so no allocator needed (simpler than OXC's arena approach)
- Must construct `swc_common::Span` from `start`/`end` using `BytePos`
- Returns a `SingleThreadedComments` alongside the `Module` for comment reinsertion
- SWC `Ident` requires `SyntaxContext::empty()` for newly generated identifiers

**`Span` reconstruction:**
- `Span::new(BytePos(start), BytePos(end))` — use node's `start`/`end` from BaseNode

### 5. `diagnostics.rs` — CompileResult → SWC Diagnostics

```rust
use swc_common::errors::Handler;

pub fn emit_diagnostics(
    result: &CompileResult,
    handler: &Handler,
)
```

SWC uses `Handler` for error reporting rather than returning diagnostic objects. Map:
- `LoggerEvent::CompileError` → `handler.struct_warn()` or `handler.struct_err()` with span
- `CompileResult::Error` → `handler.struct_err()`

For contexts where a `Handler` is not available (e.g., standalone usage), also provide:

```rust
pub struct DiagnosticMessage {
    pub severity: Severity,
    pub message: String,
    pub span: Option<(u32, u32)>,
}

pub fn compile_result_to_diagnostics(result: &CompileResult) -> Vec<DiagnosticMessage>
```

### 6. `lib.rs` — Public API

#### Native Transform API

```rust
/// Result of compiling a program.
pub struct TransformResult {
    /// The compiled program (None if no changes needed).
    pub module: Option<Module>,
    /// Comments from the compiled program.
    pub comments: Option<SingleThreadedComments>,
    pub diagnostics: Vec<DiagnosticMessage>,
    pub events: Vec<LoggerEvent>,
}

/// Primary API — accepts pre-parsed AST + scope info.
pub fn transform(
    module: &Module,
    source_text: &str,
    comments: &dyn Comments,
    options: PluginOptions,
) -> TransformResult
```

Flow:
1. Prefilter (`has_react_like_functions`). Skip if `compilationMode == "all"`.
2. Build scope info (`build_scope_info`)
3. Convert AST (`convert_module`)
4. Call `compile_program(file, scope_info, options)`
5. On success with modified AST: deserialize JSON → `File`, reverse-convert to SWC AST
6. Collect diagnostics

#### VisitMut Implementation (for SWC transform pipeline)

```rust
pub struct ReactCompilerVisitor {
    options: PluginOptions,
    source_text: String,
    comments: SingleThreadedComments,
}

impl VisitMut for ReactCompilerVisitor {
    fn visit_mut_module(&mut self, module: &mut Module) {
        let result = transform(module, &self.source_text, &self.comments, self.options.clone());
        if let Some(compiled_module) = result.module {
            *module = compiled_module;
        }
        // Diagnostics are logged/emitted via handler
    }
}
```

This allows React Compiler to be composed with other SWC transforms in a pipeline.

#### Convenience API

```rust
/// Parse and transform source text.
pub fn transform_source(
    source_text: &str,
    options: PluginOptions,
) -> TransformResult
```

### 7. `plugin.rs` — Wasm Plugin Entry Point (feature-gated)

```rust
#[cfg(feature = "plugin")]
use swc_core::plugin::{plugin_transform, proxied::TransformPluginProgramMetadata};

#[cfg(feature = "plugin")]
#[plugin_transform]
pub fn react_compiler_plugin(
    program: Program,
    metadata: TransformPluginProgramMetadata,
) -> Program {
    let source_text = metadata
        .get_context(&TransformPluginProgramMetadata::source_file_name_key())
        .unwrap_or_default();
    let comments = metadata.comments;
    let options: PluginOptions = serde_json::from_str(
        &metadata.get_transform_plugin_config().unwrap_or_default()
    ).unwrap_or_default();

    // Note: Wasm plugin uses serialized/proxied types
    // The conversion logic is shared but types come from swc_core::plugin::proxied
    let result = transform(&program.expect_module(), &source_text, &comments, options);
    match result.module {
        Some(module) => Program::Module(module),
        None => program,
    }
}
```

> **Note:** The Wasm plugin API uses proxied types that serialize across the Wasm boundary. The exact API depends on the `swc_core` version. The plugin entry point may need adaptation as SWC's plugin API evolves.

## Scope Analysis: Detailed Design

Since SWC lacks built-in semantic analysis, scope construction is the riskiest part of this integration. Two approaches are viable:

### Approach A: Custom Visitor (More control, more code)

```rust
struct ScopeBuilder {
    scopes: Vec<ScopeData>,
    bindings: Vec<BindingData>,
    scope_stack: Vec<ScopeId>,
    node_to_scope: IndexMap<u32, u32>,
    reference_to_binding: IndexMap<u32, u32>,
}

impl Visit for ScopeBuilder {
    fn visit_module(&mut self, n: &Module) { /* push scope, visit children, pop */ }
    fn visit_fn_decl(&mut self, n: &FnDecl) { /* record binding, push scope */ }
    fn visit_var_declarator(&mut self, n: &VarDeclarator) { /* record binding */ }
    fn visit_ident(&mut self, n: &Ident) { /* resolve reference */ }
    // ... etc for all scope-creating and binding-creating nodes
}
```

Pros: Full control over scope semantics, matches Babel's scope model exactly.
Cons: ~500-800 lines, must handle all edge cases (hoisting, TDZ, catch params, `with` statements, etc.).

### Approach B: SWC Resolver + Post-Processing (Recommended)

```rust
use swc_ecma_transforms_base::resolver;

pub fn build_scope_info(module: &mut Module, comments: &dyn Comments) -> ScopeInfo {
    // 1. Run SWC's resolver to assign SyntaxContext to all identifiers
    module.visit_mut_with(&mut resolver(Mark::new(), Mark::new(), false));

    // 2. Collect all bindings by walking declarations
    let mut collector = BindingCollector::default();
    module.visit_with(&mut collector);

    // 3. Build scope tree from collected data
    // Group bindings by scope, build parent chain
    // ...

    // 4. Walk references — each Ident's SyntaxContext tells us which binding it refers to
    let mut resolver = ReferenceResolver::new(&collector.bindings);
    module.visit_with(&mut resolver);

    ScopeInfo { /* ... */ }
}
```

Pros: Leverages SWC's battle-tested resolver, less code, handles edge cases.
Cons: Mutates the AST (adds syntax contexts), requires `&mut Module`, adds `swc_ecma_transforms_base` dependency.

**Recommendation:** Start with Approach B. If the resolver doesn't provide enough information (e.g., scope kinds, parent relationships), fall back to a hybrid approach where the resolver handles variable resolution and a custom visitor builds the scope tree.

## Implementation Phases

### Phase 1: Foundation (prefilter + convert_ast + convert_scope)
- `prefilter.rs` — port from OXC version, adapt to SWC AST types
- `convert_ast.rs` — SWC AST → `react_compiler_ast::File` conversion
- `convert_scope.rs` — scope analysis (most complex, start with Approach B)
- Unit tests comparing against Babel parser JSON output and scope extraction
- **Milestone:** `convert_module()` + `build_scope_info()` produce valid input for `compile_program()`

### Phase 2: Transform path (reverse converter + transform API + VisitMut)
- `convert_ast_reverse.rs` — `react_compiler_ast` → SWC AST
- `diagnostics.rs` — compile result to diagnostic messages
- `lib.rs` — `transform()`, `transform_source()`, `ReactCompilerVisitor`
- Integration tests: compile fixtures, compare output with Babel pipeline
- **Milestone:** Full transform pipeline works end-to-end

### Phase 3: Wasm plugin
- `plugin.rs` — Wasm plugin entry point
- Build system for `wasm32-wasip1` target
- Test with `@swc/core` Node.js API
- **Milestone:** `.wasm` plugin loadable by SWC

### Phase 4: Differential testing
- Cross-validate AST conversion: parse same source with Babel and SWC, compare `react_compiler_ast::File`
- Cross-validate scope info: compare `ScopeInfo` from SWC path vs Babel path
- Run full fixture suite through both pipelines, compare compiled output
- Cross-validate against OXC pipeline as well (three-way comparison)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Scope analysis correctness** | High — wrong scopes cause wrong compilation | Use SWC resolver (battle-tested); differential test against Babel; start with subset of fixtures |
| **SWC version churn** | Medium — SWC's plugin API and AST types change between major versions | Pin versions; use `swc_core` re-exports; consider supporting multiple versions via feature flags |
| **Wasm performance** | Medium — Wasm overhead may be significant for large files | Offer native transform as primary path; Wasm as distribution convenience |
| **Comment handling** | Low — different comment attachment model | Extract comments before conversion, re-attach after; test with fixtures that have directive comments |
| **TypeScript AST nodes** | Low — TS types are passed through opaquely | Serialize to `serde_json::Value` same as OXC path |

## Verification

1. **Unit tests:** Each module has tests for its conversion logic
2. **Fixture tests:** Use existing fixtures at `compiler/packages/babel-plugin-react-compiler/src/__tests__/fixtures/compiler/`
3. **Differential tests:** Compare SWC path output against Babel and OXC path output for same inputs
4. **`cargo test -p react_compiler_swc`** — run all crate tests
5. **Scope correctness:** Snapshot `ScopeInfo` JSON and compare against Babel extraction golden files
6. **Wasm plugin test:** Load `.wasm` plugin via `@swc/core` and compile a fixture
