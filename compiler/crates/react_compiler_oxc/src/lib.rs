// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

pub mod convert_ast;
pub mod convert_ast_reverse;
pub mod convert_scope;
pub mod diagnostics;
pub mod prefilter;

use convert_ast::convert_program;
use convert_ast_reverse::convert_program_to_oxc;
use convert_scope::convert_scope_info;
use diagnostics::compile_result_to_diagnostics;
use prefilter::has_react_like_functions;
use react_compiler::entrypoint::compile_result::{CompileResult, LoggerEvent};
use react_compiler::entrypoint::plugin_options::PluginOptions;

/// Result of compiling a program via the OXC frontend (JSON AST output).
pub struct TransformResult {
    /// The compiled program AST as JSON (None if no changes needed).
    pub program_json: Option<serde_json::Value>,
    pub diagnostics: Vec<oxc_diagnostics::OxcDiagnostic>,
    pub events: Vec<LoggerEvent>,
}

/// Result of compiling a program via the OXC frontend (OXC AST output).
pub struct TransformOxcResult<'a> {
    /// The compiled program as an OXC AST (None if no changes needed).
    pub program: Option<oxc_ast::ast::Program<'a>>,
    pub diagnostics: Vec<oxc_diagnostics::OxcDiagnostic>,
    pub events: Vec<LoggerEvent>,
}

/// Result of linting a program via the OXC frontend.
pub struct LintResult {
    pub diagnostics: Vec<oxc_diagnostics::OxcDiagnostic>,
}

/// Primary transform API — returns compiled AST as JSON.
pub fn transform(
    program: &oxc_ast::ast::Program,
    semantic: &oxc_semantic::Semantic,
    source_text: &str,
    options: PluginOptions,
) -> TransformResult {
    if options.compilation_mode != "all" && !has_react_like_functions(program) {
        return TransformResult {
            program_json: None,
            diagnostics: vec![],
            events: vec![],
        };
    }

    let file = convert_program(program, source_text);
    let scope_info = convert_scope_info(semantic, program);
    let result =
        react_compiler::entrypoint::program::compile_program(file, scope_info, options);

    let diagnostics = compile_result_to_diagnostics(&result);
    let (program_json, events) = match result {
        CompileResult::Success { ast, events, .. } => (ast, events),
        CompileResult::Error { events, .. } => (None, events),
    };

    TransformResult {
        program_json,
        diagnostics,
        events,
    }
}

/// Transform API with OXC AST output — converts compiled result back to OXC AST.
///
/// The `output_allocator` is used to allocate the output OXC AST nodes.
/// It should be separate from the allocator used for the input AST.
pub fn transform_to_oxc<'a>(
    program: &oxc_ast::ast::Program,
    semantic: &oxc_semantic::Semantic,
    source_text: &str,
    options: PluginOptions,
    output_allocator: &'a oxc_allocator::Allocator,
) -> TransformOxcResult<'a> {
    let result = transform(program, semantic, source_text, options);

    let oxc_program = result.program_json.and_then(|json| {
        let file: react_compiler_ast::File = serde_json::from_value(json).ok()?;
        Some(convert_program_to_oxc(&file, output_allocator))
    });

    TransformOxcResult {
        program: oxc_program,
        diagnostics: result.diagnostics,
        events: result.events,
    }
}

/// Convenience wrapper — parses source text, runs semantic analysis, then transforms.
pub fn transform_source(
    source_text: &str,
    source_type: oxc_span::SourceType,
    options: PluginOptions,
) -> TransformResult {
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, source_text, source_type).parse();

    let semantic = oxc_semantic::SemanticBuilder::new()
        .build(&parsed.program)
        .semantic;

    transform(&parsed.program, &semantic, source_text, options)
}

/// Lint API — accepts pre-parsed OXC AST + semantic.
/// Same as transform but only collects diagnostics, no AST output.
pub fn lint(
    program: &oxc_ast::ast::Program,
    semantic: &oxc_semantic::Semantic,
    source_text: &str,
    options: PluginOptions,
) -> LintResult {
    let mut opts = options;
    opts.no_emit = true;

    let result = transform(program, semantic, source_text, opts);
    LintResult {
        diagnostics: result.diagnostics,
    }
}

/// Convenience wrapper — parses source text, runs semantic analysis, then lints.
pub fn lint_source(
    source_text: &str,
    source_type: oxc_span::SourceType,
    options: PluginOptions,
) -> LintResult {
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, source_text, source_type).parse();

    let semantic = oxc_semantic::SemanticBuilder::new()
        .build(&parsed.program)
        .semantic;

    lint(&parsed.program, &semantic, source_text, options)
}
