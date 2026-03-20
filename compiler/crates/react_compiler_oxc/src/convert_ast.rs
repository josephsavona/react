/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use oxc_ast::ast as oxc;
use oxc_span::{GetSpan, Span};
use react_compiler_ast::{
    common::{BaseNode, Comment, CommentData, Position, SourceLocation},
    declarations::*,
    expressions::*,
    jsx::*,
    literals::*,
    operators::*,
    patterns::*,
    statements::*,
    File, Program, SourceType,
};

/// Converts an OXC AST to the React compiler's Babel-compatible AST.
pub fn convert_program(program: &oxc::Program, source_text: &str) -> File {
    let ctx = ConvertCtx::new(source_text);
    let base = ctx.make_base_node(program.span);

    let body: Vec<Statement> = program
        .body
        .iter()
        .map(|stmt| ctx.convert_statement(stmt))
        .collect();

    let directives = program
        .directives
        .iter()
        .map(|d| ctx.convert_directive(d))
        .collect();

    let source_type = if program.source_type.is_module() {
        SourceType::Module
    } else {
        SourceType::Script
    };

    let comments = ctx.convert_comments(&program.comments);

    File {
        base: ctx.make_base_node(program.span),
        program: Program {
            base,
            body,
            directives,
            source_type,
            interpreter: None,
            source_file: None,
        },
        comments,
        errors: vec![],
    }
}

struct ConvertCtx<'a> {
    source_text: &'a str,
    line_offsets: Vec<u32>,
}

impl<'a> ConvertCtx<'a> {
    fn new(source_text: &'a str) -> Self {
        let mut line_offsets = vec![0u32];
        for (i, ch) in source_text.char_indices() {
            if ch == '\n' {
                line_offsets.push((i + 1) as u32);
            }
        }
        Self {
            source_text,
            line_offsets,
        }
    }

    fn make_base_node(&self, span: Span) -> BaseNode {
        BaseNode {
            node_type: None,
            start: Some(span.start),
            end: Some(span.end),
            loc: Some(self.source_location(span)),
            range: None,
            extra: None,
            leading_comments: None,
            inner_comments: None,
            trailing_comments: None,
        }
    }

    fn position(&self, offset: u32) -> Position {
        let line_idx = match self.line_offsets.binary_search(&offset) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let line_start = self.line_offsets[line_idx];
        Position {
            line: (line_idx as u32) + 1, // 1-based
            column: offset - line_start,
            index: Some(offset),
        }
    }

    fn source_location(&self, span: Span) -> SourceLocation {
        SourceLocation {
            start: self.position(span.start),
            end: self.position(span.end),
            filename: None,
            identifier_name: None,
        }
    }

    fn convert_comments(
        &self,
        comments: &oxc_allocator::Vec<'_, oxc::Comment>,
    ) -> Vec<Comment> {
        comments
            .iter()
            .map(|c| {
                let content_span = c.content_span();
                let value = self.source_text
                    [content_span.start as usize..content_span.end as usize]
                    .to_string();
                let data = CommentData {
                    value,
                    start: Some(c.span.start),
                    end: Some(c.span.end),
                    loc: Some(self.source_location(c.span)),
                };
                match c.kind {
                    oxc_ast::ast::CommentKind::Line => Comment::CommentLine(data),
                    oxc_ast::ast::CommentKind::SingleLineBlock
                    | oxc_ast::ast::CommentKind::MultiLineBlock => Comment::CommentBlock(data),
                }
            })
            .collect()
    }

    fn convert_directive(&self, d: &oxc::Directive) -> Directive {
        Directive {
            base: self.make_base_node(d.span),
            value: DirectiveLiteral {
                base: self.make_base_node(d.expression.span),
                value: d.directive.to_string(),
            },
        }
    }

    // ===== Statements =====

    fn convert_statement(&self, stmt: &oxc::Statement) -> Statement {
        match stmt {
            oxc::Statement::BlockStatement(s) => {
                Statement::BlockStatement(self.convert_block_statement(s))
            }
            oxc::Statement::BreakStatement(s) => Statement::BreakStatement(BreakStatement {
                base: self.make_base_node(s.span),
                label: s.label.as_ref().map(|l| self.convert_label_identifier(l)),
            }),
            oxc::Statement::ContinueStatement(s) => {
                Statement::ContinueStatement(ContinueStatement {
                    base: self.make_base_node(s.span),
                    label: s.label.as_ref().map(|l| self.convert_label_identifier(l)),
                })
            }
            oxc::Statement::DebuggerStatement(s) => {
                Statement::DebuggerStatement(DebuggerStatement {
                    base: self.make_base_node(s.span),
                })
            }
            oxc::Statement::DoWhileStatement(s) => {
                Statement::DoWhileStatement(DoWhileStatement {
                    base: self.make_base_node(s.span),
                    test: Box::new(self.convert_expression(&s.test)),
                    body: Box::new(self.convert_statement(&s.body)),
                })
            }
            oxc::Statement::EmptyStatement(s) => Statement::EmptyStatement(EmptyStatement {
                base: self.make_base_node(s.span),
            }),
            oxc::Statement::ExpressionStatement(s) => {
                Statement::ExpressionStatement(ExpressionStatement {
                    base: self.make_base_node(s.span),
                    expression: Box::new(self.convert_expression(&s.expression)),
                })
            }
            oxc::Statement::ForInStatement(s) => Statement::ForInStatement(ForInStatement {
                base: self.make_base_node(s.span),
                left: Box::new(self.convert_for_in_of_left(&s.left)),
                right: Box::new(self.convert_expression(&s.right)),
                body: Box::new(self.convert_statement(&s.body)),
            }),
            oxc::Statement::ForOfStatement(s) => Statement::ForOfStatement(ForOfStatement {
                base: self.make_base_node(s.span),
                left: Box::new(self.convert_for_in_of_left(&s.left)),
                right: Box::new(self.convert_expression(&s.right)),
                body: Box::new(self.convert_statement(&s.body)),
                is_await: s.r#await,
            }),
            oxc::Statement::ForStatement(s) => Statement::ForStatement(ForStatement {
                base: self.make_base_node(s.span),
                init: s.init.as_ref().map(|i| Box::new(self.convert_for_init(i))),
                test: s
                    .test
                    .as_ref()
                    .map(|t| Box::new(self.convert_expression(t))),
                update: s
                    .update
                    .as_ref()
                    .map(|u| Box::new(self.convert_expression(u))),
                body: Box::new(self.convert_statement(&s.body)),
            }),
            oxc::Statement::IfStatement(s) => Statement::IfStatement(IfStatement {
                base: self.make_base_node(s.span),
                test: Box::new(self.convert_expression(&s.test)),
                consequent: Box::new(self.convert_statement(&s.consequent)),
                alternate: s
                    .alternate
                    .as_ref()
                    .map(|a| Box::new(self.convert_statement(a))),
            }),
            oxc::Statement::LabeledStatement(s) => {
                Statement::LabeledStatement(LabeledStatement {
                    base: self.make_base_node(s.span),
                    label: self.convert_label_identifier(&s.label),
                    body: Box::new(self.convert_statement(&s.body)),
                })
            }
            oxc::Statement::ReturnStatement(s) => Statement::ReturnStatement(ReturnStatement {
                base: self.make_base_node(s.span),
                argument: s
                    .argument
                    .as_ref()
                    .map(|a| Box::new(self.convert_expression(a))),
            }),
            oxc::Statement::SwitchStatement(s) => Statement::SwitchStatement(SwitchStatement {
                base: self.make_base_node(s.span),
                discriminant: Box::new(self.convert_expression(&s.discriminant)),
                cases: s
                    .cases
                    .iter()
                    .map(|c| SwitchCase {
                        base: self.make_base_node(c.span),
                        test: c
                            .test
                            .as_ref()
                            .map(|t| Box::new(self.convert_expression(t))),
                        consequent: c
                            .consequent
                            .iter()
                            .map(|s| self.convert_statement(s))
                            .collect(),
                    })
                    .collect(),
            }),
            oxc::Statement::ThrowStatement(s) => Statement::ThrowStatement(ThrowStatement {
                base: self.make_base_node(s.span),
                argument: Box::new(self.convert_expression(&s.argument)),
            }),
            oxc::Statement::TryStatement(s) => Statement::TryStatement(TryStatement {
                base: self.make_base_node(s.span),
                block: self.convert_block_statement(&s.block),
                handler: s.handler.as_ref().map(|h| self.convert_catch_clause(h)),
                finalizer: s
                    .finalizer
                    .as_ref()
                    .map(|f| self.convert_block_statement(f)),
            }),
            oxc::Statement::WhileStatement(s) => Statement::WhileStatement(WhileStatement {
                base: self.make_base_node(s.span),
                test: Box::new(self.convert_expression(&s.test)),
                body: Box::new(self.convert_statement(&s.body)),
            }),
            oxc::Statement::WithStatement(s) => Statement::WithStatement(WithStatement {
                base: self.make_base_node(s.span),
                object: Box::new(self.convert_expression(&s.object)),
                body: Box::new(self.convert_statement(&s.body)),
            }),
            // Declaration variants
            oxc::Statement::VariableDeclaration(d) => {
                Statement::VariableDeclaration(self.convert_variable_declaration(d))
            }
            oxc::Statement::FunctionDeclaration(f) => {
                Statement::FunctionDeclaration(self.convert_function_to_declaration(f))
            }
            oxc::Statement::ClassDeclaration(c) => {
                Statement::ClassDeclaration(self.convert_class_to_declaration(c))
            }
            oxc::Statement::TSTypeAliasDeclaration(d) => {
                Statement::TSTypeAliasDeclaration(self.convert_ts_type_alias(d))
            }
            oxc::Statement::TSInterfaceDeclaration(d) => {
                Statement::TSInterfaceDeclaration(self.convert_ts_interface(d))
            }
            oxc::Statement::TSEnumDeclaration(d) => {
                Statement::TSEnumDeclaration(self.convert_ts_enum(d))
            }
            oxc::Statement::TSModuleDeclaration(d) => {
                Statement::TSModuleDeclaration(self.convert_ts_module(d))
            }
            oxc::Statement::TSGlobalDeclaration(_) | oxc::Statement::TSImportEqualsDeclaration(_) => {
                // These don't have direct Babel equivalents; emit as empty statement
                Statement::EmptyStatement(EmptyStatement {
                    base: self.make_base_node(stmt.span()),
                })
            }
            // Module declaration variants
            oxc::Statement::ImportDeclaration(d) => {
                Statement::ImportDeclaration(self.convert_import_declaration(d))
            }
            oxc::Statement::ExportNamedDeclaration(d) => {
                Statement::ExportNamedDeclaration(self.convert_export_named(d))
            }
            oxc::Statement::ExportDefaultDeclaration(d) => {
                Statement::ExportDefaultDeclaration(self.convert_export_default(d))
            }
            oxc::Statement::ExportAllDeclaration(d) => {
                Statement::ExportAllDeclaration(self.convert_export_all(d))
            }
            oxc::Statement::TSExportAssignment(_) | oxc::Statement::TSNamespaceExportDeclaration(_) => {
                // No Babel equivalent
                Statement::EmptyStatement(EmptyStatement {
                    base: self.make_base_node(stmt.span()),
                })
            }
        }
    }

    fn convert_block_statement(&self, block: &oxc::BlockStatement) -> BlockStatement {
        BlockStatement {
            base: self.make_base_node(block.span),
            body: block
                .body
                .iter()
                .map(|s| self.convert_statement(s))
                .collect(),
            directives: vec![],
        }
    }

    fn convert_function_body_to_block(
        &self,
        body: &oxc::FunctionBody,
    ) -> BlockStatement {
        BlockStatement {
            base: self.make_base_node(body.span),
            body: body
                .statements
                .iter()
                .map(|s| self.convert_statement(s))
                .collect(),
            directives: body
                .directives
                .iter()
                .map(|d| self.convert_directive(d))
                .collect(),
        }
    }

    fn convert_catch_clause(&self, clause: &oxc::CatchClause) -> CatchClause {
        CatchClause {
            base: self.make_base_node(clause.span),
            param: clause
                .param
                .as_ref()
                .map(|p| self.convert_binding_pattern(&p.pattern)),
            body: self.convert_block_statement(&clause.body),
        }
    }

    fn convert_for_init(&self, init: &oxc::ForStatementInit) -> ForInit {
        match init {
            oxc::ForStatementInit::VariableDeclaration(v) => {
                ForInit::VariableDeclaration(self.convert_variable_declaration(v))
            }
            other => {
                ForInit::Expression(Box::new(self.convert_expression(other.to_expression())))
            }
        }
    }

    fn convert_for_in_of_left(&self, left: &oxc::ForStatementLeft) -> ForInOfLeft {
        match left {
            oxc::ForStatementLeft::VariableDeclaration(v) => {
                ForInOfLeft::VariableDeclaration(self.convert_variable_declaration(v))
            }
            other => {
                ForInOfLeft::Pattern(Box::new(
                    self.convert_assignment_target(other.to_assignment_target()),
                ))
            }
        }
    }

    fn convert_variable_declaration(
        &self,
        decl: &oxc::VariableDeclaration,
    ) -> VariableDeclaration {
        VariableDeclaration {
            base: self.make_base_node(decl.span),
            declarations: decl
                .declarations
                .iter()
                .map(|d| self.convert_variable_declarator(d))
                .collect(),
            kind: match decl.kind {
                oxc::VariableDeclarationKind::Var => VariableDeclarationKind::Var,
                oxc::VariableDeclarationKind::Let => VariableDeclarationKind::Let,
                oxc::VariableDeclarationKind::Const => VariableDeclarationKind::Const,
                oxc::VariableDeclarationKind::Using => VariableDeclarationKind::Using,
                oxc::VariableDeclarationKind::AwaitUsing => VariableDeclarationKind::Using,
            },
            declare: if decl.declare { Some(true) } else { None },
        }
    }

    fn convert_variable_declarator(
        &self,
        d: &oxc::VariableDeclarator,
    ) -> VariableDeclarator {
        VariableDeclarator {
            base: self.make_base_node(d.span),
            id: self.convert_binding_pattern(&d.id),
            init: d
                .init
                .as_ref()
                .map(|e| Box::new(self.convert_expression(e))),
            definite: if d.definite { Some(true) } else { None },
        }
    }

    // ===== Expressions =====

    fn convert_expression(&self, expr: &oxc::Expression) -> Expression {
        match expr {
            oxc::Expression::BooleanLiteral(lit) => {
                Expression::BooleanLiteral(BooleanLiteral {
                    base: self.make_base_node(lit.span),
                    value: lit.value,
                })
            }
            oxc::Expression::NullLiteral(lit) => Expression::NullLiteral(NullLiteral {
                base: self.make_base_node(lit.span),
            }),
            oxc::Expression::NumericLiteral(lit) => {
                Expression::NumericLiteral(NumericLiteral {
                    base: self.make_base_node(lit.span),
                    value: lit.value,
                })
            }
            oxc::Expression::BigIntLiteral(lit) => {
                Expression::BigIntLiteral(BigIntLiteral {
                    base: self.make_base_node(lit.span),
                    value: lit.value.to_string(),
                })
            }
            oxc::Expression::RegExpLiteral(lit) => {
                Expression::RegExpLiteral(RegExpLiteral {
                    base: self.make_base_node(lit.span),
                    pattern: lit.regex.pattern.text.to_string(),
                    flags: self.convert_regexp_flags(lit.regex.flags),
                })
            }
            oxc::Expression::StringLiteral(lit) => {
                Expression::StringLiteral(StringLiteral {
                    base: self.make_base_node(lit.span),
                    value: lit.value.to_string(),
                })
            }
            oxc::Expression::TemplateLiteral(lit) => {
                Expression::TemplateLiteral(self.convert_template_literal(lit))
            }
            oxc::Expression::Identifier(id) => {
                Expression::Identifier(self.convert_identifier_reference(id))
            }
            oxc::Expression::MetaProperty(mp) => Expression::MetaProperty(MetaProperty {
                base: self.make_base_node(mp.span),
                meta: self.convert_identifier_name(&mp.meta),
                property: self.convert_identifier_name(&mp.property),
            }),
            oxc::Expression::Super(s) => Expression::Super(Super {
                base: self.make_base_node(s.span),
            }),
            oxc::Expression::ArrayExpression(arr) => {
                Expression::ArrayExpression(self.convert_array_expression(arr))
            }
            oxc::Expression::ArrowFunctionExpression(arrow) => {
                Expression::ArrowFunctionExpression(self.convert_arrow_function(arrow))
            }
            oxc::Expression::AssignmentExpression(assign) => {
                Expression::AssignmentExpression(self.convert_assignment_expression(assign))
            }
            oxc::Expression::AwaitExpression(a) => {
                Expression::AwaitExpression(AwaitExpression {
                    base: self.make_base_node(a.span),
                    argument: Box::new(self.convert_expression(&a.argument)),
                })
            }
            oxc::Expression::BinaryExpression(bin) => {
                Expression::BinaryExpression(BinaryExpression {
                    base: self.make_base_node(bin.span),
                    operator: self.convert_binary_operator(bin.operator),
                    left: Box::new(self.convert_expression(&bin.left)),
                    right: Box::new(self.convert_expression(&bin.right)),
                })
            }
            oxc::Expression::CallExpression(call) => {
                // If it's inside a ChainExpression the `optional` flag matters,
                // but for a standalone CallExpression optional is always false.
                Expression::CallExpression(self.convert_call_expression(call, false))
            }
            oxc::Expression::ChainExpression(chain) => {
                self.convert_chain_expression(chain)
            }
            oxc::Expression::ClassExpression(class) => {
                Expression::ClassExpression(self.convert_class_expression(class))
            }
            oxc::Expression::ConditionalExpression(cond) => {
                Expression::ConditionalExpression(ConditionalExpression {
                    base: self.make_base_node(cond.span),
                    test: Box::new(self.convert_expression(&cond.test)),
                    consequent: Box::new(self.convert_expression(&cond.consequent)),
                    alternate: Box::new(self.convert_expression(&cond.alternate)),
                })
            }
            oxc::Expression::FunctionExpression(func) => {
                Expression::FunctionExpression(self.convert_function_expression(func))
            }
            oxc::Expression::ImportExpression(imp) => {
                // Babel represents dynamic import() as a CallExpression with
                // callee = Import node. We emit a CallExpression wrapping an Import.
                Expression::CallExpression(CallExpression {
                    base: self.make_base_node(imp.span),
                    callee: Box::new(Expression::Import(Import {
                        base: self.make_base_node(imp.span),
                    })),
                    arguments: {
                        let mut args = vec![self.convert_expression(&imp.source)];
                        if let Some(ref opts) = imp.options {
                            args.push(self.convert_expression(opts));
                        }
                        args
                    },
                    type_parameters: None,
                    type_arguments: None,
                    optional: None,
                })
            }
            oxc::Expression::LogicalExpression(log) => {
                Expression::LogicalExpression(LogicalExpression {
                    base: self.make_base_node(log.span),
                    operator: self.convert_logical_operator(log.operator),
                    left: Box::new(self.convert_expression(&log.left)),
                    right: Box::new(self.convert_expression(&log.right)),
                })
            }
            oxc::Expression::NewExpression(n) => {
                Expression::NewExpression(NewExpression {
                    base: self.make_base_node(n.span),
                    callee: Box::new(self.convert_expression(&n.callee)),
                    arguments: n
                        .arguments
                        .iter()
                        .map(|a| self.convert_argument(a))
                        .collect(),
                    type_parameters: None,
                    type_arguments: None,
                })
            }
            oxc::Expression::ObjectExpression(obj) => {
                Expression::ObjectExpression(self.convert_object_expression(obj))
            }
            oxc::Expression::ParenthesizedExpression(p) => {
                Expression::ParenthesizedExpression(ParenthesizedExpression {
                    base: self.make_base_node(p.span),
                    expression: Box::new(self.convert_expression(&p.expression)),
                })
            }
            oxc::Expression::SequenceExpression(seq) => {
                Expression::SequenceExpression(SequenceExpression {
                    base: self.make_base_node(seq.span),
                    expressions: seq
                        .expressions
                        .iter()
                        .map(|e| self.convert_expression(e))
                        .collect(),
                })
            }
            oxc::Expression::TaggedTemplateExpression(tag) => {
                Expression::TaggedTemplateExpression(TaggedTemplateExpression {
                    base: self.make_base_node(tag.span),
                    tag: Box::new(self.convert_expression(&tag.tag)),
                    quasi: self.convert_template_literal(&tag.quasi),
                    type_parameters: None,
                })
            }
            oxc::Expression::ThisExpression(t) => Expression::ThisExpression(ThisExpression {
                base: self.make_base_node(t.span),
            }),
            oxc::Expression::UnaryExpression(un) => {
                Expression::UnaryExpression(UnaryExpression {
                    base: self.make_base_node(un.span),
                    operator: self.convert_unary_operator(un.operator),
                    prefix: true,
                    argument: Box::new(self.convert_expression(&un.argument)),
                })
            }
            oxc::Expression::UpdateExpression(up) => {
                Expression::UpdateExpression(UpdateExpression {
                    base: self.make_base_node(up.span),
                    operator: self.convert_update_operator(up.operator),
                    argument: Box::new(
                        self.convert_simple_assignment_target_to_expression(&up.argument),
                    ),
                    prefix: up.prefix,
                })
            }
            oxc::Expression::YieldExpression(y) => {
                Expression::YieldExpression(YieldExpression {
                    base: self.make_base_node(y.span),
                    argument: y
                        .argument
                        .as_ref()
                        .map(|a| Box::new(self.convert_expression(a))),
                    delegate: y.delegate,
                })
            }
            oxc::Expression::PrivateInExpression(p) => {
                // Babel represents `#x in obj` as a BinaryExpression with left = PrivateName
                Expression::BinaryExpression(BinaryExpression {
                    base: self.make_base_node(p.span),
                    operator: BinaryOperator::In,
                    left: Box::new(Expression::PrivateName(PrivateName {
                        base: self.make_base_node(p.left.span),
                        id: Identifier {
                            base: self.make_base_node(p.left.span),
                            name: p.left.name.to_string(),
                            type_annotation: None,
                            optional: None,
                            decorators: None,
                        },
                    })),
                    right: Box::new(self.convert_expression(&p.right)),
                })
            }
            oxc::Expression::JSXElement(el) => {
                Expression::JSXElement(Box::new(self.convert_jsx_element(el)))
            }
            oxc::Expression::JSXFragment(frag) => {
                Expression::JSXFragment(self.convert_jsx_fragment(frag))
            }
            oxc::Expression::TSAsExpression(e) => {
                Expression::TSAsExpression(TSAsExpression {
                    base: self.make_base_node(e.span),
                    expression: Box::new(self.convert_expression(&e.expression)),
                    type_annotation: Box::new(serde_json::Value::Null),
                })
            }
            oxc::Expression::TSSatisfiesExpression(e) => {
                Expression::TSSatisfiesExpression(TSSatisfiesExpression {
                    base: self.make_base_node(e.span),
                    expression: Box::new(self.convert_expression(&e.expression)),
                    type_annotation: Box::new(serde_json::Value::Null),
                })
            }
            oxc::Expression::TSTypeAssertion(e) => {
                Expression::TSTypeAssertion(TSTypeAssertion {
                    base: self.make_base_node(e.span),
                    expression: Box::new(self.convert_expression(&e.expression)),
                    type_annotation: Box::new(serde_json::Value::Null),
                })
            }
            oxc::Expression::TSNonNullExpression(e) => {
                Expression::TSNonNullExpression(TSNonNullExpression {
                    base: self.make_base_node(e.span),
                    expression: Box::new(self.convert_expression(&e.expression)),
                })
            }
            oxc::Expression::TSInstantiationExpression(e) => {
                Expression::TSInstantiationExpression(TSInstantiationExpression {
                    base: self.make_base_node(e.span),
                    expression: Box::new(self.convert_expression(&e.expression)),
                    type_parameters: Box::new(serde_json::Value::Null),
                })
            }
            // MemberExpression variants
            oxc::Expression::ComputedMemberExpression(m) => {
                Expression::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(self.convert_expression(&m.expression)),
                    computed: true,
                })
            }
            oxc::Expression::StaticMemberExpression(m) => {
                Expression::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(Expression::Identifier(Identifier {
                        base: self.make_base_node(m.property.span),
                        name: m.property.name.to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    })),
                    computed: false,
                })
            }
            oxc::Expression::PrivateFieldExpression(m) => {
                Expression::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(Expression::PrivateName(PrivateName {
                        base: self.make_base_node(m.field.span),
                        id: Identifier {
                            base: self.make_base_node(m.field.span),
                            name: m.field.name.to_string(),
                            type_annotation: None,
                            optional: None,
                            decorators: None,
                        },
                    })),
                    computed: false,
                })
            }
            oxc::Expression::V8IntrinsicExpression(_) => {
                // V8 intrinsics (%foo) - not supported by Babel, emit as identifier
                Expression::Identifier(Identifier {
                    base: self.make_base_node(expr.span()),
                    name: "__v8_intrinsic__".to_string(),
                    type_annotation: None,
                    optional: None,
                    decorators: None,
                })
            }
        }
    }

    // ===== Chain expression (optional chaining) =====

    fn convert_chain_expression(&self, chain: &oxc::ChainExpression) -> Expression {
        // OXC wraps optional chains in ChainExpression.
        // Babel uses OptionalCallExpression / OptionalMemberExpression instead.
        self.convert_chain_element(&chain.expression, chain.span)
    }

    fn convert_chain_element(
        &self,
        element: &oxc::ChainElement,
        _outer_span: Span,
    ) -> Expression {
        match element {
            oxc::ChainElement::CallExpression(call) => {
                Expression::OptionalCallExpression(OptionalCallExpression {
                    base: self.make_base_node(call.span),
                    callee: Box::new(self.convert_chain_callee(&call.callee)),
                    arguments: call
                        .arguments
                        .iter()
                        .map(|a| self.convert_argument(a))
                        .collect(),
                    optional: call.optional,
                    type_parameters: None,
                    type_arguments: None,
                })
            }
            oxc::ChainElement::TSNonNullExpression(e) => {
                Expression::TSNonNullExpression(TSNonNullExpression {
                    base: self.make_base_node(e.span),
                    expression: Box::new(self.convert_expression(&e.expression)),
                })
            }
            oxc::ChainElement::ComputedMemberExpression(m) => {
                Expression::OptionalMemberExpression(OptionalMemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_chain_callee(&m.object)),
                    property: Box::new(self.convert_expression(&m.expression)),
                    computed: true,
                    optional: m.optional,
                })
            }
            oxc::ChainElement::StaticMemberExpression(m) => {
                Expression::OptionalMemberExpression(OptionalMemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_chain_callee(&m.object)),
                    property: Box::new(Expression::Identifier(Identifier {
                        base: self.make_base_node(m.property.span),
                        name: m.property.name.to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    })),
                    computed: false,
                    optional: m.optional,
                })
            }
            oxc::ChainElement::PrivateFieldExpression(m) => {
                Expression::OptionalMemberExpression(OptionalMemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_chain_callee(&m.object)),
                    property: Box::new(Expression::PrivateName(PrivateName {
                        base: self.make_base_node(m.field.span),
                        id: Identifier {
                            base: self.make_base_node(m.field.span),
                            name: m.field.name.to_string(),
                            type_annotation: None,
                            optional: None,
                            decorators: None,
                        },
                    })),
                    computed: false,
                    optional: m.optional,
                })
            }
        }
    }

    /// Convert callee/object inside a chain expression. When the inner expression
    /// is itself a member/call with `optional` set, it should also become
    /// OptionalMemberExpression/OptionalCallExpression.
    fn convert_chain_callee(&self, expr: &oxc::Expression) -> Expression {
        match expr {
            oxc::Expression::ComputedMemberExpression(m) if m.optional => {
                Expression::OptionalMemberExpression(OptionalMemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_chain_callee(&m.object)),
                    property: Box::new(self.convert_expression(&m.expression)),
                    computed: true,
                    optional: true,
                })
            }
            oxc::Expression::StaticMemberExpression(m) if m.optional => {
                Expression::OptionalMemberExpression(OptionalMemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_chain_callee(&m.object)),
                    property: Box::new(Expression::Identifier(Identifier {
                        base: self.make_base_node(m.property.span),
                        name: m.property.name.to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    })),
                    computed: false,
                    optional: true,
                })
            }
            oxc::Expression::PrivateFieldExpression(m) if m.optional => {
                Expression::OptionalMemberExpression(OptionalMemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_chain_callee(&m.object)),
                    property: Box::new(Expression::PrivateName(PrivateName {
                        base: self.make_base_node(m.field.span),
                        id: Identifier {
                            base: self.make_base_node(m.field.span),
                            name: m.field.name.to_string(),
                            type_annotation: None,
                            optional: None,
                            decorators: None,
                        },
                    })),
                    computed: false,
                    optional: true,
                })
            }
            oxc::Expression::CallExpression(call) if call.optional => {
                Expression::OptionalCallExpression(OptionalCallExpression {
                    base: self.make_base_node(call.span),
                    callee: Box::new(self.convert_chain_callee(&call.callee)),
                    arguments: call
                        .arguments
                        .iter()
                        .map(|a| self.convert_argument(a))
                        .collect(),
                    optional: true,
                    type_parameters: None,
                    type_arguments: None,
                })
            }
            _ => self.convert_expression(expr),
        }
    }

    // ===== Function helpers =====

    fn convert_function_to_declaration(&self, func: &oxc::Function) -> FunctionDeclaration {
        let body = func
            .body
            .as_ref()
            .map(|b| self.convert_function_body_to_block(b))
            .unwrap_or_else(|| BlockStatement {
                base: self.make_base_node(func.span),
                body: vec![],
                directives: vec![],
            });
        FunctionDeclaration {
            base: self.make_base_node(func.span),
            id: func.id.as_ref().map(|id| self.convert_binding_identifier(id)),
            params: self.convert_formal_parameters(&func.params),
            body,
            generator: func.generator,
            is_async: func.r#async,
            declare: if func.declare { Some(true) } else { None },
            return_type: func
                .return_type
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            type_parameters: func
                .type_parameters
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            predicate: None,
        }
    }

    fn convert_function_expression(&self, func: &oxc::Function) -> FunctionExpression {
        let body = func
            .body
            .as_ref()
            .map(|b| self.convert_function_body_to_block(b))
            .unwrap_or_else(|| BlockStatement {
                base: self.make_base_node(func.span),
                body: vec![],
                directives: vec![],
            });
        FunctionExpression {
            base: self.make_base_node(func.span),
            id: func.id.as_ref().map(|id| self.convert_binding_identifier(id)),
            params: self.convert_formal_parameters(&func.params),
            body,
            generator: func.generator,
            is_async: func.r#async,
            return_type: func
                .return_type
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            type_parameters: func
                .type_parameters
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
        }
    }

    fn convert_arrow_function(
        &self,
        arrow: &oxc::ArrowFunctionExpression,
    ) -> ArrowFunctionExpression {
        // If expression=true, body has a single statement which is a return of the expression.
        // Babel's ArrowFunctionBody should be Expression variant in that case.
        let body: ArrowFunctionBody = if arrow.expression {
            // The body's first statement should be an expression
            let expr = arrow
                .body
                .statements
                .first()
                .and_then(|s| {
                    if let oxc::Statement::ExpressionStatement(es) = s {
                        Some(self.convert_expression(&es.expression))
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| {
                    Expression::Identifier(Identifier {
                        base: BaseNode::default(),
                        name: "undefined".to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    })
                });
            ArrowFunctionBody::Expression(Box::new(expr))
        } else {
            ArrowFunctionBody::BlockStatement(self.convert_function_body_to_block(&arrow.body))
        };

        ArrowFunctionExpression {
            base: self.make_base_node(arrow.span),
            params: self.convert_formal_parameters(&arrow.params),
            body: Box::new(body),
            id: None,
            generator: false,
            is_async: arrow.r#async,
            expression: Some(arrow.expression),
            return_type: arrow
                .return_type
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            type_parameters: arrow
                .type_parameters
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            predicate: None,
        }
    }

    fn convert_formal_parameters(
        &self,
        params: &oxc::FormalParameters,
    ) -> Vec<PatternLike> {
        let mut result: Vec<PatternLike> = params
            .items
            .iter()
            .map(|p| self.convert_formal_parameter(p))
            .collect();

        if let Some(ref rest) = params.rest {
            result.push(PatternLike::RestElement(RestElement {
                base: self.make_base_node(rest.span),
                argument: Box::new(self.convert_binding_pattern(&rest.rest.argument)),
                type_annotation: rest
                    .type_annotation
                    .as_ref()
                    .map(|_| Box::new(serde_json::Value::Null)),
                decorators: None,
            }));
        }

        result
    }

    fn convert_formal_parameter(&self, param: &oxc::FormalParameter) -> PatternLike {
        // OXC FormalParameter has pattern + optional initializer + type_annotation
        // If there's an initializer, wrap in AssignmentPattern
        let base_pattern = self.convert_binding_pattern(&param.pattern);

        if let Some(ref init) = param.initializer {
            PatternLike::AssignmentPattern(AssignmentPattern {
                base: self.make_base_node(param.span),
                left: Box::new(base_pattern),
                right: Box::new(self.convert_expression(init)),
                type_annotation: param
                    .type_annotation
                    .as_ref()
                    .map(|_| Box::new(serde_json::Value::Null)),
                decorators: None,
            })
        } else if param.type_annotation.is_some() {
            // If there's a type annotation but no initializer, add it to the pattern
            self.add_type_annotation_to_pattern(base_pattern, param.type_annotation.is_some())
        } else {
            base_pattern
        }
    }

    fn add_type_annotation_to_pattern(
        &self,
        pattern: PatternLike,
        _has_annotation: bool,
    ) -> PatternLike {
        // For simplicity, just return the pattern as-is.
        // Type annotations are attached to identifiers when possible in convert_binding_pattern.
        pattern
    }

    // ===== Patterns =====

    fn convert_binding_pattern(&self, pattern: &oxc::BindingPattern) -> PatternLike {
        match pattern {
            oxc::BindingPattern::BindingIdentifier(id) => {
                PatternLike::Identifier(self.convert_binding_identifier(id))
            }
            oxc::BindingPattern::ObjectPattern(obj) => {
                PatternLike::ObjectPattern(self.convert_object_pattern(obj))
            }
            oxc::BindingPattern::ArrayPattern(arr) => {
                PatternLike::ArrayPattern(self.convert_array_pattern(arr))
            }
            oxc::BindingPattern::AssignmentPattern(assign) => {
                PatternLike::AssignmentPattern(AssignmentPattern {
                    base: self.make_base_node(assign.span),
                    left: Box::new(self.convert_binding_pattern(&assign.left)),
                    right: Box::new(self.convert_expression(&assign.right)),
                    type_annotation: None,
                    decorators: None,
                })
            }
        }
    }

    fn convert_object_pattern(&self, obj: &oxc::ObjectPattern) -> ObjectPattern {
        let mut properties: Vec<ObjectPatternProperty> = obj
            .properties
            .iter()
            .map(|p| self.convert_binding_property(p))
            .collect();

        if let Some(ref rest) = obj.rest {
            properties.push(ObjectPatternProperty::RestElement(RestElement {
                base: self.make_base_node(rest.span),
                argument: Box::new(self.convert_binding_pattern(&rest.argument)),
                type_annotation: None,
                decorators: None,
            }));
        }

        ObjectPattern {
            base: self.make_base_node(obj.span),
            properties,
            type_annotation: None,
            decorators: None,
        }
    }

    fn convert_binding_property(&self, prop: &oxc::BindingProperty) -> ObjectPatternProperty {
        ObjectPatternProperty::ObjectProperty(ObjectPatternProp {
            base: self.make_base_node(prop.span),
            key: Box::new(self.convert_property_key(&prop.key)),
            value: Box::new(self.convert_binding_pattern(&prop.value)),
            computed: prop.computed,
            shorthand: prop.shorthand,
            decorators: None,
            method: None,
        })
    }

    fn convert_array_pattern(&self, arr: &oxc::ArrayPattern) -> ArrayPattern {
        let mut elements: Vec<Option<PatternLike>> = arr
            .elements
            .iter()
            .map(|e| e.as_ref().map(|p| self.convert_binding_pattern(p)))
            .collect();

        if let Some(ref rest) = arr.rest {
            elements.push(Some(PatternLike::RestElement(RestElement {
                base: self.make_base_node(rest.span),
                argument: Box::new(self.convert_binding_pattern(&rest.argument)),
                type_annotation: None,
                decorators: None,
            })));
        }

        ArrayPattern {
            base: self.make_base_node(arr.span),
            elements,
            type_annotation: None,
            decorators: None,
        }
    }

    // ===== AssignmentTarget → PatternLike =====

    fn convert_assignment_target(&self, target: &oxc::AssignmentTarget) -> PatternLike {
        match target {
            oxc::AssignmentTarget::AssignmentTargetIdentifier(id) => {
                PatternLike::Identifier(self.convert_identifier_reference(id))
            }
            oxc::AssignmentTarget::ComputedMemberExpression(m) => {
                PatternLike::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(self.convert_expression(&m.expression)),
                    computed: true,
                })
            }
            oxc::AssignmentTarget::StaticMemberExpression(m) => {
                PatternLike::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(Expression::Identifier(Identifier {
                        base: self.make_base_node(m.property.span),
                        name: m.property.name.to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    })),
                    computed: false,
                })
            }
            oxc::AssignmentTarget::PrivateFieldExpression(m) => {
                PatternLike::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(Expression::PrivateName(PrivateName {
                        base: self.make_base_node(m.field.span),
                        id: Identifier {
                            base: self.make_base_node(m.field.span),
                            name: m.field.name.to_string(),
                            type_annotation: None,
                            optional: None,
                            decorators: None,
                        },
                    })),
                    computed: false,
                })
            }
            oxc::AssignmentTarget::ArrayAssignmentTarget(arr) => {
                PatternLike::ArrayPattern(self.convert_array_assignment_target(arr))
            }
            oxc::AssignmentTarget::ObjectAssignmentTarget(obj) => {
                PatternLike::ObjectPattern(self.convert_object_assignment_target(obj))
            }
            // TS assignment target variants — just unwrap to expression
            oxc::AssignmentTarget::TSAsExpression(e) => {
                self.convert_assignment_target_via_expression(e.span, &e.expression)
            }
            oxc::AssignmentTarget::TSSatisfiesExpression(e) => {
                self.convert_assignment_target_via_expression(e.span, &e.expression)
            }
            oxc::AssignmentTarget::TSNonNullExpression(e) => {
                self.convert_assignment_target_via_expression(e.span, &e.expression)
            }
            oxc::AssignmentTarget::TSTypeAssertion(e) => {
                self.convert_assignment_target_via_expression(e.span, &e.expression)
            }
        }
    }

    fn convert_assignment_target_via_expression(
        &self,
        _span: Span,
        expr: &oxc::Expression,
    ) -> PatternLike {
        // For TS expressions used as assignment targets, unwrap to get the inner target
        match expr {
            oxc::Expression::Identifier(id) => {
                PatternLike::Identifier(self.convert_identifier_reference(id))
            }
            oxc::Expression::ComputedMemberExpression(m) => {
                PatternLike::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(self.convert_expression(&m.expression)),
                    computed: true,
                })
            }
            oxc::Expression::StaticMemberExpression(m) => {
                PatternLike::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(Expression::Identifier(Identifier {
                        base: self.make_base_node(m.property.span),
                        name: m.property.name.to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    })),
                    computed: false,
                })
            }
            _ => {
                // Fallback: emit as identifier
                PatternLike::Identifier(Identifier {
                    base: self.make_base_node(expr.span()),
                    name: "__unknown_target__".to_string(),
                    type_annotation: None,
                    optional: None,
                    decorators: None,
                })
            }
        }
    }

    fn convert_array_assignment_target(
        &self,
        arr: &oxc::ArrayAssignmentTarget,
    ) -> ArrayPattern {
        let mut elements: Vec<Option<PatternLike>> = arr
            .elements
            .iter()
            .map(|e| {
                e.as_ref().map(|target| {
                    self.convert_assignment_target_maybe_default(target)
                })
            })
            .collect();

        if let Some(ref rest) = arr.rest {
            elements.push(Some(PatternLike::RestElement(RestElement {
                base: self.make_base_node(rest.span),
                argument: Box::new(self.convert_assignment_target(&rest.target)),
                type_annotation: None,
                decorators: None,
            })));
        }

        ArrayPattern {
            base: self.make_base_node(arr.span),
            elements,
            type_annotation: None,
            decorators: None,
        }
    }

    fn convert_object_assignment_target(
        &self,
        obj: &oxc::ObjectAssignmentTarget,
    ) -> ObjectPattern {
        let mut properties: Vec<ObjectPatternProperty> = obj
            .properties
            .iter()
            .map(|p| self.convert_assignment_target_property(p))
            .collect();

        if let Some(ref rest) = obj.rest {
            properties.push(ObjectPatternProperty::RestElement(RestElement {
                base: self.make_base_node(rest.span),
                argument: Box::new(self.convert_assignment_target(&rest.target)),
                type_annotation: None,
                decorators: None,
            }));
        }

        ObjectPattern {
            base: self.make_base_node(obj.span),
            properties,
            type_annotation: None,
            decorators: None,
        }
    }

    fn convert_assignment_target_property(
        &self,
        prop: &oxc::AssignmentTargetProperty,
    ) -> ObjectPatternProperty {
        match prop {
            oxc::AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(p) => {
                let id = self.convert_identifier_reference(&p.binding);
                let (value, shorthand) = if let Some(ref init) = p.init {
                    (
                        Box::new(PatternLike::AssignmentPattern(AssignmentPattern {
                            base: self.make_base_node(p.span),
                            left: Box::new(PatternLike::Identifier(id.clone())),
                            right: Box::new(self.convert_expression(init)),
                            type_annotation: None,
                            decorators: None,
                        })),
                        true,
                    )
                } else {
                    (Box::new(PatternLike::Identifier(id.clone())), true)
                };
                ObjectPatternProperty::ObjectProperty(ObjectPatternProp {
                    base: self.make_base_node(p.span),
                    key: Box::new(Expression::Identifier(id)),
                    value,
                    computed: false,
                    shorthand,
                    decorators: None,
                    method: None,
                })
            }
            oxc::AssignmentTargetProperty::AssignmentTargetPropertyProperty(p) => {
                ObjectPatternProperty::ObjectProperty(ObjectPatternProp {
                    base: self.make_base_node(p.span),
                    key: Box::new(self.convert_property_key(&p.name)),
                    value: Box::new(
                        self.convert_assignment_target_maybe_default(&p.binding),
                    ),
                    computed: p.computed,
                    shorthand: false,
                    decorators: None,
                    method: None,
                })
            }
        }
    }

    fn convert_assignment_target_maybe_default(
        &self,
        target: &oxc::AssignmentTargetMaybeDefault,
    ) -> PatternLike {
        match target {
            oxc::AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(d) => {
                PatternLike::AssignmentPattern(AssignmentPattern {
                    base: self.make_base_node(d.span),
                    left: Box::new(self.convert_assignment_target(&d.binding)),
                    right: Box::new(self.convert_expression(&d.init)),
                    type_annotation: None,
                    decorators: None,
                })
            }
            other => {
                self.convert_assignment_target(other.to_assignment_target())
            }
        }
    }

    fn convert_assignment_expression(
        &self,
        assign: &oxc::AssignmentExpression,
    ) -> AssignmentExpression {
        AssignmentExpression {
            base: self.make_base_node(assign.span),
            operator: self.convert_assignment_operator(assign.operator),
            left: Box::new(self.convert_assignment_target(&assign.left)),
            right: Box::new(self.convert_expression(&assign.right)),
        }
    }

    // ===== SimpleAssignmentTarget → Expression =====

    fn convert_simple_assignment_target_to_expression(
        &self,
        target: &oxc::SimpleAssignmentTarget,
    ) -> Expression {
        match target {
            oxc::SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
                Expression::Identifier(self.convert_identifier_reference(id))
            }
            oxc::SimpleAssignmentTarget::ComputedMemberExpression(m) => {
                Expression::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(self.convert_expression(&m.expression)),
                    computed: true,
                })
            }
            oxc::SimpleAssignmentTarget::StaticMemberExpression(m) => {
                Expression::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(Expression::Identifier(Identifier {
                        base: self.make_base_node(m.property.span),
                        name: m.property.name.to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    })),
                    computed: false,
                })
            }
            oxc::SimpleAssignmentTarget::PrivateFieldExpression(m) => {
                Expression::MemberExpression(MemberExpression {
                    base: self.make_base_node(m.span),
                    object: Box::new(self.convert_expression(&m.object)),
                    property: Box::new(Expression::PrivateName(PrivateName {
                        base: self.make_base_node(m.field.span),
                        id: Identifier {
                            base: self.make_base_node(m.field.span),
                            name: m.field.name.to_string(),
                            type_annotation: None,
                            optional: None,
                            decorators: None,
                        },
                    })),
                    computed: false,
                })
            }
            oxc::SimpleAssignmentTarget::TSAsExpression(e) => {
                self.convert_expression(&e.expression)
            }
            oxc::SimpleAssignmentTarget::TSSatisfiesExpression(e) => {
                self.convert_expression(&e.expression)
            }
            oxc::SimpleAssignmentTarget::TSNonNullExpression(e) => {
                self.convert_expression(&e.expression)
            }
            oxc::SimpleAssignmentTarget::TSTypeAssertion(e) => {
                self.convert_expression(&e.expression)
            }
        }
    }

    // ===== Object expression =====

    fn convert_object_expression(&self, obj: &oxc::ObjectExpression) -> ObjectExpression {
        ObjectExpression {
            base: self.make_base_node(obj.span),
            properties: obj
                .properties
                .iter()
                .map(|p| self.convert_object_property_kind(p))
                .collect(),
        }
    }

    fn convert_object_property_kind(
        &self,
        prop: &oxc::ObjectPropertyKind,
    ) -> ObjectExpressionProperty {
        match prop {
            oxc::ObjectPropertyKind::ObjectProperty(p) => {
                self.convert_object_property(p)
            }
            oxc::ObjectPropertyKind::SpreadProperty(s) => {
                ObjectExpressionProperty::SpreadElement(SpreadElement {
                    base: self.make_base_node(s.span),
                    argument: Box::new(self.convert_expression(&s.argument)),
                })
            }
        }
    }

    fn convert_object_property(&self, prop: &oxc::ObjectProperty) -> ObjectExpressionProperty {
        // OXC uses PropertyKind (Init, Get, Set) + method flag.
        // Babel separates ObjectProperty from ObjectMethod.
        match prop.kind {
            oxc::PropertyKind::Get | oxc::PropertyKind::Set => {
                // getter/setter → ObjectMethod
                let method_kind = match prop.kind {
                    oxc::PropertyKind::Get => ObjectMethodKind::Get,
                    oxc::PropertyKind::Set => ObjectMethodKind::Set,
                    _ => unreachable!(),
                };
                if let oxc::Expression::FunctionExpression(ref func) = prop.value {
                    ObjectExpressionProperty::ObjectMethod(ObjectMethod {
                        base: self.make_base_node(prop.span),
                        method: false,
                        kind: method_kind,
                        key: Box::new(self.convert_property_key(&prop.key)),
                        params: self.convert_formal_parameters(&func.params),
                        body: func
                            .body
                            .as_ref()
                            .map(|b| self.convert_function_body_to_block(b))
                            .unwrap_or_else(|| BlockStatement {
                                base: self.make_base_node(func.span),
                                body: vec![],
                                directives: vec![],
                            }),
                        computed: prop.computed,
                        id: None,
                        generator: func.generator,
                        is_async: func.r#async,
                        decorators: None,
                        return_type: None,
                        type_parameters: None,
                    })
                } else {
                    // Shouldn't happen, but fall back to ObjectProperty
                    ObjectExpressionProperty::ObjectProperty(ObjectProperty {
                        base: self.make_base_node(prop.span),
                        key: Box::new(self.convert_property_key(&prop.key)),
                        value: Box::new(self.convert_expression(&prop.value)),
                        computed: prop.computed,
                        shorthand: prop.shorthand,
                        decorators: None,
                        method: Some(prop.method),
                    })
                }
            }
            oxc::PropertyKind::Init if prop.method => {
                // method shorthand → ObjectMethod
                if let oxc::Expression::FunctionExpression(ref func) = prop.value {
                    ObjectExpressionProperty::ObjectMethod(ObjectMethod {
                        base: self.make_base_node(prop.span),
                        method: true,
                        kind: ObjectMethodKind::Method,
                        key: Box::new(self.convert_property_key(&prop.key)),
                        params: self.convert_formal_parameters(&func.params),
                        body: func
                            .body
                            .as_ref()
                            .map(|b| self.convert_function_body_to_block(b))
                            .unwrap_or_else(|| BlockStatement {
                                base: self.make_base_node(func.span),
                                body: vec![],
                                directives: vec![],
                            }),
                        computed: prop.computed,
                        id: None,
                        generator: func.generator,
                        is_async: func.r#async,
                        decorators: None,
                        return_type: None,
                        type_parameters: None,
                    })
                } else {
                    ObjectExpressionProperty::ObjectProperty(ObjectProperty {
                        base: self.make_base_node(prop.span),
                        key: Box::new(self.convert_property_key(&prop.key)),
                        value: Box::new(self.convert_expression(&prop.value)),
                        computed: prop.computed,
                        shorthand: prop.shorthand,
                        decorators: None,
                        method: Some(true),
                    })
                }
            }
            oxc::PropertyKind::Init => {
                ObjectExpressionProperty::ObjectProperty(ObjectProperty {
                    base: self.make_base_node(prop.span),
                    key: Box::new(self.convert_property_key(&prop.key)),
                    value: Box::new(self.convert_expression(&prop.value)),
                    computed: prop.computed,
                    shorthand: prop.shorthand,
                    decorators: None,
                    method: Some(false),
                })
            }
        }
    }

    // ===== Array expression =====

    fn convert_array_expression(&self, arr: &oxc::ArrayExpression) -> ArrayExpression {
        ArrayExpression {
            base: self.make_base_node(arr.span),
            elements: arr
                .elements
                .iter()
                .map(|e| self.convert_array_expression_element(e))
                .collect(),
        }
    }

    fn convert_array_expression_element(
        &self,
        elem: &oxc::ArrayExpressionElement,
    ) -> Option<Expression> {
        match elem {
            oxc::ArrayExpressionElement::SpreadElement(s) => {
                Some(Expression::SpreadElement(SpreadElement {
                    base: self.make_base_node(s.span),
                    argument: Box::new(self.convert_expression(&s.argument)),
                }))
            }
            oxc::ArrayExpressionElement::Elision(_) => None,
            other => Some(self.convert_expression(other.to_expression())),
        }
    }

    // ===== Call expression =====

    fn convert_call_expression(
        &self,
        call: &oxc::CallExpression,
        _in_chain: bool,
    ) -> CallExpression {
        CallExpression {
            base: self.make_base_node(call.span),
            callee: Box::new(self.convert_expression(&call.callee)),
            arguments: call
                .arguments
                .iter()
                .map(|a| self.convert_argument(a))
                .collect(),
            type_parameters: None,
            type_arguments: None,
            optional: None,
        }
    }

    fn convert_argument(&self, arg: &oxc::Argument) -> Expression {
        match arg {
            oxc::Argument::SpreadElement(s) => Expression::SpreadElement(SpreadElement {
                base: self.make_base_node(s.span),
                argument: Box::new(self.convert_expression(&s.argument)),
            }),
            other => self.convert_expression(other.to_expression()),
        }
    }

    // ===== Template literal =====

    fn convert_template_literal(&self, tl: &oxc::TemplateLiteral) -> TemplateLiteral {
        TemplateLiteral {
            base: self.make_base_node(tl.span),
            quasis: tl
                .quasis
                .iter()
                .map(|q| TemplateElement {
                    base: self.make_base_node(q.span),
                    value: TemplateElementValue {
                        raw: q.value.raw.to_string(),
                        cooked: q.value.cooked.as_ref().map(|c| c.to_string()),
                    },
                    tail: q.tail,
                })
                .collect(),
            expressions: tl
                .expressions
                .iter()
                .map(|e| self.convert_expression(e))
                .collect(),
        }
    }

    // ===== Class =====

    fn convert_class_to_declaration(&self, class: &oxc::Class) -> ClassDeclaration {
        ClassDeclaration {
            base: self.make_base_node(class.span),
            id: class
                .id
                .as_ref()
                .map(|id| self.convert_binding_identifier(id)),
            super_class: class
                .super_class
                .as_ref()
                .map(|s| Box::new(self.convert_expression(s))),
            body: ClassBody {
                base: self.make_base_node(class.body.span),
                body: vec![], // Class body members are opaque
            },
            decorators: None,
            is_abstract: None,
            declare: if class.declare { Some(true) } else { None },
            implements: None,
            super_type_parameters: None,
            type_parameters: class
                .type_parameters
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            mixins: None,
        }
    }

    fn convert_class_expression(&self, class: &oxc::Class) -> ClassExpression {
        ClassExpression {
            base: self.make_base_node(class.span),
            id: class
                .id
                .as_ref()
                .map(|id| self.convert_binding_identifier(id)),
            super_class: class
                .super_class
                .as_ref()
                .map(|s| Box::new(self.convert_expression(s))),
            body: ClassBody {
                base: self.make_base_node(class.body.span),
                body: vec![],
            },
            decorators: None,
            implements: None,
            super_type_parameters: None,
            type_parameters: class
                .type_parameters
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
        }
    }

    // ===== JSX =====

    fn convert_jsx_element(&self, el: &oxc::JSXElement) -> JSXElement {
        let self_closing = el.closing_element.is_none();
        JSXElement {
            base: self.make_base_node(el.span),
            opening_element: self.convert_jsx_opening_element(&el.opening_element),
            closing_element: el
                .closing_element
                .as_ref()
                .map(|c| self.convert_jsx_closing_element(c)),
            children: el
                .children
                .iter()
                .map(|c| self.convert_jsx_child(c))
                .collect(),
            self_closing: Some(self_closing),
        }
    }

    fn convert_jsx_opening_element(
        &self,
        el: &oxc::JSXOpeningElement,
    ) -> JSXOpeningElement {
        // OXC doesn't store self_closing on the opening element directly.
        // The caller (convert_jsx_element) sets self_closing based on closing_element.
        JSXOpeningElement {
            base: self.make_base_node(el.span),
            name: self.convert_jsx_element_name(&el.name),
            attributes: el
                .attributes
                .iter()
                .map(|a| self.convert_jsx_attribute_item(a))
                .collect(),
            self_closing: false, // Will be set by caller
            type_parameters: None,
        }
    }

    fn convert_jsx_closing_element(
        &self,
        el: &oxc::JSXClosingElement,
    ) -> JSXClosingElement {
        JSXClosingElement {
            base: self.make_base_node(el.span),
            name: self.convert_jsx_element_name(&el.name),
        }
    }

    fn convert_jsx_element_name(&self, name: &oxc::JSXElementName) -> JSXElementName {
        match name {
            oxc::JSXElementName::Identifier(id) => {
                JSXElementName::JSXIdentifier(JSXIdentifier {
                    base: self.make_base_node(id.span),
                    name: id.name.to_string(),
                })
            }
            oxc::JSXElementName::IdentifierReference(id) => {
                // In Babel, component names (starting with uppercase) are JSXIdentifiers too
                JSXElementName::JSXIdentifier(JSXIdentifier {
                    base: self.make_base_node(id.span),
                    name: id.name.to_string(),
                })
            }
            oxc::JSXElementName::NamespacedName(ns) => {
                JSXElementName::JSXNamespacedName(JSXNamespacedName {
                    base: self.make_base_node(ns.span),
                    namespace: JSXIdentifier {
                        base: self.make_base_node(ns.namespace.span),
                        name: ns.namespace.name.to_string(),
                    },
                    name: JSXIdentifier {
                        base: self.make_base_node(ns.name.span),
                        name: ns.name.name.to_string(),
                    },
                })
            }
            oxc::JSXElementName::MemberExpression(m) => {
                JSXElementName::JSXMemberExpression(self.convert_jsx_member_expression(m))
            }
            oxc::JSXElementName::ThisExpression(t) => {
                // `<this.foo>` - Babel represents `this` as JSXIdentifier
                JSXElementName::JSXIdentifier(JSXIdentifier {
                    base: self.make_base_node(t.span),
                    name: "this".to_string(),
                })
            }
        }
    }

    fn convert_jsx_member_expression(
        &self,
        m: &oxc::JSXMemberExpression,
    ) -> JSXMemberExpression {
        JSXMemberExpression {
            base: self.make_base_node(m.span),
            object: Box::new(self.convert_jsx_member_expression_object(&m.object)),
            property: JSXIdentifier {
                base: self.make_base_node(m.property.span),
                name: m.property.name.to_string(),
            },
        }
    }

    fn convert_jsx_member_expression_object(
        &self,
        obj: &oxc::JSXMemberExpressionObject,
    ) -> JSXMemberExprObject {
        match obj {
            oxc::JSXMemberExpressionObject::IdentifierReference(id) => {
                JSXMemberExprObject::JSXIdentifier(JSXIdentifier {
                    base: self.make_base_node(id.span),
                    name: id.name.to_string(),
                })
            }
            oxc::JSXMemberExpressionObject::MemberExpression(m) => {
                JSXMemberExprObject::JSXMemberExpression(Box::new(
                    self.convert_jsx_member_expression(m),
                ))
            }
            oxc::JSXMemberExpressionObject::ThisExpression(t) => {
                JSXMemberExprObject::JSXIdentifier(JSXIdentifier {
                    base: self.make_base_node(t.span),
                    name: "this".to_string(),
                })
            }
        }
    }

    fn convert_jsx_attribute_item(&self, item: &oxc::JSXAttributeItem) -> JSXAttributeItem {
        match item {
            oxc::JSXAttributeItem::Attribute(attr) => {
                JSXAttributeItem::JSXAttribute(self.convert_jsx_attribute(attr))
            }
            oxc::JSXAttributeItem::SpreadAttribute(spread) => {
                JSXAttributeItem::JSXSpreadAttribute(JSXSpreadAttribute {
                    base: self.make_base_node(spread.span),
                    argument: Box::new(self.convert_expression(&spread.argument)),
                })
            }
        }
    }

    fn convert_jsx_attribute(&self, attr: &oxc::JSXAttribute) -> JSXAttribute {
        JSXAttribute {
            base: self.make_base_node(attr.span),
            name: self.convert_jsx_attribute_name(&attr.name),
            value: attr
                .value
                .as_ref()
                .map(|v| self.convert_jsx_attribute_value(v)),
        }
    }

    fn convert_jsx_attribute_name(
        &self,
        name: &oxc::JSXAttributeName,
    ) -> JSXAttributeName {
        match name {
            oxc::JSXAttributeName::Identifier(id) => {
                JSXAttributeName::JSXIdentifier(JSXIdentifier {
                    base: self.make_base_node(id.span),
                    name: id.name.to_string(),
                })
            }
            oxc::JSXAttributeName::NamespacedName(ns) => {
                JSXAttributeName::JSXNamespacedName(JSXNamespacedName {
                    base: self.make_base_node(ns.span),
                    namespace: JSXIdentifier {
                        base: self.make_base_node(ns.namespace.span),
                        name: ns.namespace.name.to_string(),
                    },
                    name: JSXIdentifier {
                        base: self.make_base_node(ns.name.span),
                        name: ns.name.name.to_string(),
                    },
                })
            }
        }
    }

    fn convert_jsx_attribute_value(
        &self,
        value: &oxc::JSXAttributeValue,
    ) -> JSXAttributeValue {
        match value {
            oxc::JSXAttributeValue::StringLiteral(s) => {
                JSXAttributeValue::StringLiteral(StringLiteral {
                    base: self.make_base_node(s.span),
                    value: s.value.to_string(),
                })
            }
            oxc::JSXAttributeValue::ExpressionContainer(ec) => {
                JSXAttributeValue::JSXExpressionContainer(
                    self.convert_jsx_expression_container(ec),
                )
            }
            oxc::JSXAttributeValue::Element(el) => {
                JSXAttributeValue::JSXElement(Box::new(self.convert_jsx_element(el)))
            }
            oxc::JSXAttributeValue::Fragment(frag) => {
                JSXAttributeValue::JSXFragment(self.convert_jsx_fragment(frag))
            }
        }
    }

    fn convert_jsx_expression_container(
        &self,
        ec: &oxc::JSXExpressionContainer,
    ) -> JSXExpressionContainer {
        JSXExpressionContainer {
            base: self.make_base_node(ec.span),
            expression: self.convert_jsx_expression(&ec.expression),
        }
    }

    fn convert_jsx_expression(
        &self,
        expr: &oxc::JSXExpression,
    ) -> JSXExpressionContainerExpr {
        match expr {
            oxc::JSXExpression::EmptyExpression(e) => {
                JSXExpressionContainerExpr::JSXEmptyExpression(JSXEmptyExpression {
                    base: self.make_base_node(e.span),
                })
            }
            other => JSXExpressionContainerExpr::Expression(Box::new(
                self.convert_expression(other.to_expression()),
            )),
        }
    }

    fn convert_jsx_child(&self, child: &oxc::JSXChild) -> JSXChild {
        match child {
            oxc::JSXChild::Text(t) => JSXChild::JSXText(JSXText {
                base: self.make_base_node(t.span),
                value: t.value.to_string(),
            }),
            oxc::JSXChild::Element(el) => {
                JSXChild::JSXElement(Box::new(self.convert_jsx_element(el)))
            }
            oxc::JSXChild::Fragment(frag) => {
                JSXChild::JSXFragment(self.convert_jsx_fragment(frag))
            }
            oxc::JSXChild::ExpressionContainer(ec) => {
                JSXChild::JSXExpressionContainer(self.convert_jsx_expression_container(ec))
            }
            oxc::JSXChild::Spread(s) => JSXChild::JSXSpreadChild(JSXSpreadChild {
                base: self.make_base_node(s.span),
                expression: Box::new(self.convert_expression(&s.expression)),
            }),
        }
    }

    fn convert_jsx_fragment(&self, frag: &oxc::JSXFragment) -> JSXFragment {
        JSXFragment {
            base: self.make_base_node(frag.span),
            opening_fragment: JSXOpeningFragment {
                base: self.make_base_node(frag.opening_fragment.span),
            },
            closing_fragment: JSXClosingFragment {
                base: self.make_base_node(frag.closing_fragment.span),
            },
            children: frag
                .children
                .iter()
                .map(|c| self.convert_jsx_child(c))
                .collect(),
        }
    }

    // ===== Import/Export declarations =====

    fn convert_import_declaration(
        &self,
        decl: &oxc::ImportDeclaration,
    ) -> ImportDeclaration {
        let specifiers = match &decl.specifiers {
            Some(specs) => specs
                .iter()
                .map(|s| self.convert_import_declaration_specifier(s))
                .collect(),
            None => vec![],
        };

        ImportDeclaration {
            base: self.make_base_node(decl.span),
            specifiers,
            source: StringLiteral {
                base: self.make_base_node(decl.source.span),
                value: decl.source.value.to_string(),
            },
            import_kind: Some(self.convert_import_or_export_kind(decl.import_kind)),
            assertions: None,
            attributes: decl.with_clause.as_ref().map(|wc| {
                wc.with_entries
                    .iter()
                    .map(|a| self.convert_import_attribute(a))
                    .collect()
            }),
        }
    }

    fn convert_import_declaration_specifier(
        &self,
        spec: &oxc::ImportDeclarationSpecifier,
    ) -> ImportSpecifier {
        match spec {
            oxc::ImportDeclarationSpecifier::ImportSpecifier(s) => {
                ImportSpecifier::ImportSpecifier(ImportSpecifierData {
                    base: self.make_base_node(s.span),
                    local: self.convert_binding_identifier(&s.local),
                    imported: self.convert_module_export_name(&s.imported),
                    import_kind: Some(self.convert_import_or_export_kind(s.import_kind)),
                })
            }
            oxc::ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                ImportSpecifier::ImportDefaultSpecifier(ImportDefaultSpecifierData {
                    base: self.make_base_node(s.span),
                    local: self.convert_binding_identifier(&s.local),
                })
            }
            oxc::ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                ImportSpecifier::ImportNamespaceSpecifier(ImportNamespaceSpecifierData {
                    base: self.make_base_node(s.span),
                    local: self.convert_binding_identifier(&s.local),
                })
            }
        }
    }

    fn convert_export_named(&self, decl: &oxc::ExportNamedDeclaration) -> ExportNamedDeclaration {
        ExportNamedDeclaration {
            base: self.make_base_node(decl.span),
            declaration: decl
                .declaration
                .as_ref()
                .map(|d| Box::new(self.convert_declaration(d))),
            specifiers: decl
                .specifiers
                .iter()
                .map(|s| self.convert_export_specifier(s))
                .collect(),
            source: decl.source.as_ref().map(|s| StringLiteral {
                base: self.make_base_node(s.span),
                value: s.value.to_string(),
            }),
            export_kind: Some(self.convert_export_kind(decl.export_kind)),
            assertions: None,
            attributes: decl.with_clause.as_ref().map(|wc| {
                wc.with_entries
                    .iter()
                    .map(|a| self.convert_import_attribute(a))
                    .collect()
            }),
        }
    }

    fn convert_export_default(
        &self,
        decl: &oxc::ExportDefaultDeclaration,
    ) -> ExportDefaultDeclaration {
        ExportDefaultDeclaration {
            base: self.make_base_node(decl.span),
            declaration: Box::new(self.convert_export_default_kind(&decl.declaration)),
            export_kind: None,
        }
    }

    fn convert_export_default_kind(
        &self,
        kind: &oxc::ExportDefaultDeclarationKind,
    ) -> ExportDefaultDecl {
        match kind {
            oxc::ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                ExportDefaultDecl::FunctionDeclaration(self.convert_function_to_declaration(f))
            }
            oxc::ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                ExportDefaultDecl::ClassDeclaration(self.convert_class_to_declaration(c))
            }
            oxc::ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => {
                // TS interface as default export - unusual, emit as null expression
                ExportDefaultDecl::Expression(Box::new(Expression::NullLiteral(NullLiteral {
                    base: self.make_base_node(kind.span()),
                })))
            }
            other => ExportDefaultDecl::Expression(Box::new(
                self.convert_expression(other.to_expression()),
            )),
        }
    }

    fn convert_export_all(&self, decl: &oxc::ExportAllDeclaration) -> ExportAllDeclaration {
        ExportAllDeclaration {
            base: self.make_base_node(decl.span),
            source: StringLiteral {
                base: self.make_base_node(decl.source.span),
                value: decl.source.value.to_string(),
            },
            export_kind: Some(self.convert_export_kind(decl.export_kind)),
            assertions: None,
            attributes: decl.with_clause.as_ref().map(|wc| {
                wc.with_entries
                    .iter()
                    .map(|a| self.convert_import_attribute(a))
                    .collect()
            }),
        }
    }

    fn convert_declaration(&self, decl: &oxc::Declaration) -> Declaration {
        match decl {
            oxc::Declaration::VariableDeclaration(v) => {
                Declaration::VariableDeclaration(self.convert_variable_declaration(v))
            }
            oxc::Declaration::FunctionDeclaration(f) => {
                Declaration::FunctionDeclaration(self.convert_function_to_declaration(f))
            }
            oxc::Declaration::ClassDeclaration(c) => {
                Declaration::ClassDeclaration(self.convert_class_to_declaration(c))
            }
            oxc::Declaration::TSTypeAliasDeclaration(d) => {
                Declaration::TSTypeAliasDeclaration(self.convert_ts_type_alias(d))
            }
            oxc::Declaration::TSInterfaceDeclaration(d) => {
                Declaration::TSInterfaceDeclaration(self.convert_ts_interface(d))
            }
            oxc::Declaration::TSEnumDeclaration(d) => {
                Declaration::TSEnumDeclaration(self.convert_ts_enum(d))
            }
            oxc::Declaration::TSModuleDeclaration(d) => {
                Declaration::TSModuleDeclaration(self.convert_ts_module(d))
            }
            oxc::Declaration::TSGlobalDeclaration(_)
            | oxc::Declaration::TSImportEqualsDeclaration(_) => {
                // No direct Babel equivalent — wrap as VariableDeclaration with no declarators
                Declaration::VariableDeclaration(VariableDeclaration {
                    base: self.make_base_node(decl.span()),
                    declarations: vec![],
                    kind: VariableDeclarationKind::Const,
                    declare: Some(true),
                })
            }
        }
    }

    fn convert_export_specifier(&self, spec: &oxc::ExportSpecifier) -> ExportSpecifier {
        ExportSpecifier::ExportSpecifier(ExportSpecifierData {
            base: self.make_base_node(spec.span),
            local: self.convert_module_export_name(&spec.local),
            exported: self.convert_module_export_name(&spec.exported),
            export_kind: Some(self.convert_export_kind(spec.export_kind)),
        })
    }

    fn convert_module_export_name(&self, name: &oxc::ModuleExportName) -> ModuleExportName {
        match name {
            oxc::ModuleExportName::IdentifierName(id) => {
                ModuleExportName::Identifier(Identifier {
                    base: self.make_base_node(id.span),
                    name: id.name.to_string(),
                    type_annotation: None,
                    optional: None,
                    decorators: None,
                })
            }
            oxc::ModuleExportName::IdentifierReference(id) => {
                ModuleExportName::Identifier(self.convert_identifier_reference(id))
            }
            oxc::ModuleExportName::StringLiteral(s) => {
                ModuleExportName::StringLiteral(StringLiteral {
                    base: self.make_base_node(s.span),
                    value: s.value.to_string(),
                })
            }
        }
    }

    fn convert_import_attribute(&self, attr: &oxc::ImportAttribute) -> ImportAttribute {
        let key = match &attr.key {
            oxc::ImportAttributeKey::Identifier(id) => Identifier {
                base: self.make_base_node(id.span),
                name: id.name.to_string(),
                type_annotation: None,
                optional: None,
                decorators: None,
            },
            oxc::ImportAttributeKey::StringLiteral(s) => Identifier {
                base: self.make_base_node(s.span),
                name: s.value.to_string(),
                type_annotation: None,
                optional: None,
                decorators: None,
            },
        };
        ImportAttribute {
            base: self.make_base_node(attr.span),
            key,
            value: StringLiteral {
                base: self.make_base_node(attr.value.span),
                value: attr.value.value.to_string(),
            },
        }
    }

    fn convert_import_or_export_kind(
        &self,
        kind: oxc_ast::ast::ImportOrExportKind,
    ) -> ImportKind {
        match kind {
            oxc_ast::ast::ImportOrExportKind::Value => ImportKind::Value,
            oxc_ast::ast::ImportOrExportKind::Type => ImportKind::Type,
        }
    }

    fn convert_export_kind(&self, kind: oxc_ast::ast::ImportOrExportKind) -> ExportKind {
        match kind {
            oxc_ast::ast::ImportOrExportKind::Value => ExportKind::Value,
            oxc_ast::ast::ImportOrExportKind::Type => ExportKind::Type,
        }
    }

    // ===== TS declarations =====

    fn convert_ts_type_alias(
        &self,
        d: &oxc_ast::ast::TSTypeAliasDeclaration,
    ) -> TSTypeAliasDeclaration {
        TSTypeAliasDeclaration {
            base: self.make_base_node(d.span),
            id: self.convert_binding_identifier(&d.id),
            type_annotation: Box::new(serde_json::Value::Null),
            type_parameters: d
                .type_parameters
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            declare: if d.declare { Some(true) } else { None },
        }
    }

    fn convert_ts_interface(
        &self,
        d: &oxc_ast::ast::TSInterfaceDeclaration,
    ) -> TSInterfaceDeclaration {
        TSInterfaceDeclaration {
            base: self.make_base_node(d.span),
            id: self.convert_binding_identifier(&d.id),
            body: Box::new(serde_json::Value::Null),
            type_parameters: d
                .type_parameters
                .as_ref()
                .map(|_| Box::new(serde_json::Value::Null)),
            extends: if d.extends.is_empty() {
                None
            } else {
                Some(vec![])
            },
            declare: if d.declare { Some(true) } else { None },
        }
    }

    fn convert_ts_enum(&self, d: &oxc_ast::ast::TSEnumDeclaration) -> TSEnumDeclaration {
        TSEnumDeclaration {
            base: self.make_base_node(d.span),
            id: self.convert_binding_identifier(&d.id),
            members: vec![],
            declare: if d.declare { Some(true) } else { None },
            is_const: if d.r#const { Some(true) } else { None },
        }
    }

    fn convert_ts_module(
        &self,
        d: &oxc_ast::ast::TSModuleDeclaration,
    ) -> TSModuleDeclaration {
        TSModuleDeclaration {
            base: self.make_base_node(d.span),
            id: Box::new(serde_json::Value::Null),
            body: Box::new(serde_json::Value::Null),
            declare: if d.declare { Some(true) } else { None },
            global: None,
        }
    }

    // ===== Identifiers =====

    fn convert_identifier_reference(&self, id: &oxc::IdentifierReference) -> Identifier {
        Identifier {
            base: self.make_base_node(id.span),
            name: id.name.to_string(),
            type_annotation: None,
            optional: None,
            decorators: None,
        }
    }

    fn convert_binding_identifier(&self, id: &oxc::BindingIdentifier) -> Identifier {
        Identifier {
            base: self.make_base_node(id.span),
            name: id.name.to_string(),
            type_annotation: None,
            optional: None,
            decorators: None,
        }
    }

    fn convert_identifier_name(&self, id: &oxc::IdentifierName) -> Identifier {
        Identifier {
            base: self.make_base_node(id.span),
            name: id.name.to_string(),
            type_annotation: None,
            optional: None,
            decorators: None,
        }
    }

    fn convert_label_identifier(&self, id: &oxc::LabelIdentifier) -> Identifier {
        Identifier {
            base: self.make_base_node(id.span),
            name: id.name.to_string(),
            type_annotation: None,
            optional: None,
            decorators: None,
        }
    }

    // ===== Property key =====

    fn convert_property_key(&self, key: &oxc::PropertyKey) -> Expression {
        match key {
            oxc::PropertyKey::StaticIdentifier(id) => Expression::Identifier(Identifier {
                base: self.make_base_node(id.span),
                name: id.name.to_string(),
                type_annotation: None,
                optional: None,
                decorators: None,
            }),
            oxc::PropertyKey::PrivateIdentifier(id) => {
                Expression::PrivateName(PrivateName {
                    base: self.make_base_node(id.span),
                    id: Identifier {
                        base: self.make_base_node(id.span),
                        name: id.name.to_string(),
                        type_annotation: None,
                        optional: None,
                        decorators: None,
                    },
                })
            }
            other => self.convert_expression(other.to_expression()),
        }
    }

    // ===== Operators =====

    fn convert_binary_operator(
        &self,
        op: oxc_syntax::operator::BinaryOperator,
    ) -> BinaryOperator {
        use oxc_syntax::operator::BinaryOperator as OxcBinOp;
        match op {
            OxcBinOp::Equality => BinaryOperator::Eq,
            OxcBinOp::Inequality => BinaryOperator::Neq,
            OxcBinOp::StrictEquality => BinaryOperator::StrictEq,
            OxcBinOp::StrictInequality => BinaryOperator::StrictNeq,
            OxcBinOp::LessThan => BinaryOperator::Lt,
            OxcBinOp::LessEqualThan => BinaryOperator::Lte,
            OxcBinOp::GreaterThan => BinaryOperator::Gt,
            OxcBinOp::GreaterEqualThan => BinaryOperator::Gte,
            OxcBinOp::ShiftLeft => BinaryOperator::Shl,
            OxcBinOp::ShiftRight => BinaryOperator::Shr,
            OxcBinOp::ShiftRightZeroFill => BinaryOperator::UShr,
            OxcBinOp::Addition => BinaryOperator::Add,
            OxcBinOp::Subtraction => BinaryOperator::Sub,
            OxcBinOp::Multiplication => BinaryOperator::Mul,
            OxcBinOp::Division => BinaryOperator::Div,
            OxcBinOp::Remainder => BinaryOperator::Rem,
            OxcBinOp::BitwiseOR => BinaryOperator::BitOr,
            OxcBinOp::BitwiseXOR => BinaryOperator::BitXor,
            OxcBinOp::BitwiseAnd => BinaryOperator::BitAnd,
            OxcBinOp::In => BinaryOperator::In,
            OxcBinOp::Instanceof => BinaryOperator::Instanceof,
            OxcBinOp::Exponential => BinaryOperator::Exp,
        }
    }

    fn convert_logical_operator(
        &self,
        op: oxc_syntax::operator::LogicalOperator,
    ) -> LogicalOperator {
        use oxc_syntax::operator::LogicalOperator as OxcLogOp;
        match op {
            OxcLogOp::Or => LogicalOperator::Or,
            OxcLogOp::And => LogicalOperator::And,
            OxcLogOp::Coalesce => LogicalOperator::NullishCoalescing,
        }
    }

    fn convert_unary_operator(
        &self,
        op: oxc_syntax::operator::UnaryOperator,
    ) -> UnaryOperator {
        use oxc_syntax::operator::UnaryOperator as OxcUnOp;
        match op {
            OxcUnOp::UnaryPlus => UnaryOperator::Plus,
            OxcUnOp::UnaryNegation => UnaryOperator::Neg,
            OxcUnOp::LogicalNot => UnaryOperator::Not,
            OxcUnOp::BitwiseNot => UnaryOperator::BitNot,
            OxcUnOp::Typeof => UnaryOperator::TypeOf,
            OxcUnOp::Void => UnaryOperator::Void,
            OxcUnOp::Delete => UnaryOperator::Delete,
        }
    }

    fn convert_update_operator(
        &self,
        op: oxc_syntax::operator::UpdateOperator,
    ) -> UpdateOperator {
        use oxc_syntax::operator::UpdateOperator as OxcUpOp;
        match op {
            OxcUpOp::Increment => UpdateOperator::Increment,
            OxcUpOp::Decrement => UpdateOperator::Decrement,
        }
    }

    fn convert_assignment_operator(
        &self,
        op: oxc_syntax::operator::AssignmentOperator,
    ) -> AssignmentOperator {
        use oxc_syntax::operator::AssignmentOperator as OxcAssOp;
        match op {
            OxcAssOp::Assign => AssignmentOperator::Assign,
            OxcAssOp::Addition => AssignmentOperator::AddAssign,
            OxcAssOp::Subtraction => AssignmentOperator::SubAssign,
            OxcAssOp::Multiplication => AssignmentOperator::MulAssign,
            OxcAssOp::Division => AssignmentOperator::DivAssign,
            OxcAssOp::Remainder => AssignmentOperator::RemAssign,
            OxcAssOp::Exponential => AssignmentOperator::ExpAssign,
            OxcAssOp::ShiftLeft => AssignmentOperator::ShlAssign,
            OxcAssOp::ShiftRight => AssignmentOperator::ShrAssign,
            OxcAssOp::ShiftRightZeroFill => AssignmentOperator::UShrAssign,
            OxcAssOp::BitwiseOR => AssignmentOperator::BitOrAssign,
            OxcAssOp::BitwiseXOR => AssignmentOperator::BitXorAssign,
            OxcAssOp::BitwiseAnd => AssignmentOperator::BitAndAssign,
            OxcAssOp::LogicalOr => AssignmentOperator::OrAssign,
            OxcAssOp::LogicalAnd => AssignmentOperator::AndAssign,
            OxcAssOp::LogicalNullish => AssignmentOperator::NullishAssign,
        }
    }

    fn convert_regexp_flags(&self, flags: oxc_ast::ast::RegExpFlags) -> String {
        use oxc_ast::ast::RegExpFlags;
        let mut result = String::new();
        if flags.contains(RegExpFlags::D) {
            result.push('d');
        }
        if flags.contains(RegExpFlags::G) {
            result.push('g');
        }
        if flags.contains(RegExpFlags::I) {
            result.push('i');
        }
        if flags.contains(RegExpFlags::M) {
            result.push('m');
        }
        if flags.contains(RegExpFlags::S) {
            result.push('s');
        }
        if flags.contains(RegExpFlags::U) {
            result.push('u');
        }
        if flags.contains(RegExpFlags::V) {
            result.push('v');
        }
        if flags.contains(RegExpFlags::Y) {
            result.push('y');
        }
        result
    }
}
