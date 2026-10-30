// SPDX-License-Identifier: AGPL-3.0-only

import { relative, resolve, sep } from "node:path";
import ts from "typescript";

export const API_METHODS = {
  get: "GET",
  post: "POST",
  postRaw: "POST",
  put: "PUT",
  putRaw: "PUT",
  patch: "PATCH",
  delete: "DELETE",
} as const;

const MAX_VARIANTS = 256;
const DYNAMIC_MARKER_PREFIX = "__POSTWAVE_DYNAMIC_";

interface BoundExpression {
  expression: ts.Expression;
  context: EvaluationContext;
}

interface EvaluationContext {
  bindings: Map<ts.Symbol, BoundExpression>;
  activeSymbols: Set<ts.Symbol>;
}

export interface DynamicPathUse {
  marker: string;
  safe: boolean;
  expression: string;
  reason: string;
  file: string;
  line: number;
}

interface StringVariant {
  value: string;
  dynamics: DynamicPathUse[];
  terminated: boolean;
  finiteValue: boolean;
  bindableSpans: Array<{ start: number; end: number }>;
}

type Evaluation =
  | { ok: true; variants: StringVariant[] }
  | { ok: false; reason: string };

export interface ApiClientCall {
  method: string;
  file: string;
  line: number;
  expression: string;
  paths: ResolvedApiPath[];
  dynamicUses: DynamicPathUse[];
}

export interface ResolvedApiPath {
  value: string;
  /** Zero-based path segments produced by a finite typed substitution. */
  bindableSegments: number[];
}

export interface ApiClientCallIssue {
  file: string;
  line: number;
  method: string;
  expression: string;
  reason: string;
}

export interface ApiClientCallAudit {
  calls: ApiClientCall[];
  unresolved: ApiClientCallIssue[];
  unsafeDynamicSegments: ApiClientCallIssue[];
}

export interface MountedRouteMatch {
  mounted: boolean;
  route?: string;
}

interface GatewayRoute {
  key: string;
  method: string;
  path: string;
  segments: string[];
  score: number;
}

export interface GatewayRouteMatcher {
  match(method: string, path: string | ResolvedApiPath): MountedRouteMatch;
}

function sourceLocation(node: ts.Node): { file: string; line: number } {
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file: resolve(source.fileName), line: line + 1 };
}

function dedupeVariants(variants: StringVariant[]): StringVariant[] {
  const deduped = new Map<string, StringVariant>();
  for (const variant of variants) {
    const dynamicKey = variant.dynamics
      .map((dynamic) => `${dynamic.marker}:${dynamic.safe ? "safe" : "raw"}`)
      .join("|");
    deduped.set(
      `${variant.value}\u0000${variant.terminated}\u0000${variant.finiteValue}` +
        `\u0000${JSON.stringify(variant.bindableSpans)}\u0000${dynamicKey}`,
      variant,
    );
  }
  const result = [...deduped.values()];
  if (result.length > MAX_VARIANTS) {
    throw new Error(
      `finite path expansion exceeded the ${MAX_VARIANTS}-variant review ceiling`,
    );
  }
  return result;
}

function appendLiteral(variant: StringVariant, literal: string): StringVariant {
  if (variant.terminated) return variant;
  const delimiter = literal.search(/[?#]/u);
  if (delimiter < 0) {
    return {
      ...variant,
      value: variant.value + literal,
      finiteValue: false,
    };
  }
  return {
    ...variant,
    value: variant.value + literal.slice(0, delimiter),
    terminated: true,
    finiteValue: false,
  };
}

function combine(
  left: StringVariant[],
  right: StringVariant[],
): StringVariant[] {
  const combined: StringVariant[] = [];
  for (const lhs of left) {
    if (lhs.terminated) {
      combined.push(lhs);
      continue;
    }
    for (const rhs of right) {
      const offset = lhs.value.length;
      const appended = appendLiteral(lhs, rhs.value);
      const appendedLength = appended.value.length - offset;
      const shiftedSpans = rhs.bindableSpans
        .map((span) => ({
          start: offset + span.start,
          end: Math.min(offset + span.end, appended.value.length),
        }))
        .filter((span) => span.end > span.start);
      if (rhs.finiteValue && appendedLength > 0) {
        shiftedSpans.push({ start: offset, end: offset + appendedLength });
      }
      combined.push({
        value: appended.value,
        terminated: appended.terminated || rhs.terminated,
        dynamics: [...lhs.dynamics, ...rhs.dynamics],
        finiteValue: false,
        bindableSpans: [...lhs.bindableSpans, ...shiftedSpans],
      });
    }
  }
  return dedupeVariants(combined);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function symbolAt(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function finitePrimitiveValues(
  checker: ts.TypeChecker,
  type: ts.Type,
): string[] | null {
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint ? finitePrimitiveValues(checker, constraint) : null;
  }
  if (type.isUnion()) {
    const values: string[] = [];
    for (const member of type.types) {
      const memberValues = finitePrimitiveValues(checker, member);
      if (memberValues == null) return null;
      values.push(...memberValues);
      if (values.length > MAX_VARIANTS) return null;
    }
    return [...new Set(values)].sort();
  }
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return [(type as ts.StringLiteralType).value];
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return [String((type as ts.NumberLiteralType).value)];
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return [(type as ts.Type & { intrinsicName: string }).intrinsicName];
  }
  if (type.flags & ts.TypeFlags.Null) return ["null"];
  if (type.flags & ts.TypeFlags.Undefined) return ["undefined"];
  return null;
}

function isDelimiterSafePrimitive(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return Boolean(constraint && isDelimiterSafePrimitive(checker, constraint));
  }
  if (type.isUnion())
    return type.types.every((member) =>
      isDelimiterSafePrimitive(checker, member),
    );
  return Boolean(
    type.flags &
    (ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined),
  );
}

function functionBodyReturns(
  declaration: ts.FunctionLikeDeclaration,
): ts.Expression[] | null {
  if (!declaration.body) return null;
  if (!ts.isBlock(declaration.body)) return [declaration.body];
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== declaration.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return returns;
}

function implementationForCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.FunctionLikeDeclaration | null {
  const resolved = checker.getResolvedSignature(call)?.declaration;
  if (resolved && isFunctionImplementation(resolved)) return resolved;
  const target = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;
  const symbol = symbolAt(checker, target);
  for (const declaration of symbol?.declarations ?? []) {
    if (isFunctionImplementation(declaration)) return declaration;
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return declaration.initializer;
    }
    if (
      ts.isPropertyAssignment(declaration) &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return declaration.initializer;
    }
  }
  return null;
}

type FunctionImplementation =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

function isFunctionImplementation(
  node: ts.Node,
): node is FunctionImplementation {
  return Boolean(
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)) &&
    node.body,
  );
}

function isEncodeURIComponentTarget(
  checker: ts.TypeChecker,
  expression: ts.LeftHandSideExpression,
  seen = new Set<ts.Symbol>(),
): boolean {
  const target = unwrapExpression(expression as ts.Expression);
  if (ts.isIdentifier(target) && target.text === "encodeURIComponent") {
    return true;
  }
  if (!ts.isIdentifier(target)) return false;
  const symbol = symbolAt(checker, target);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isIdentifier(declaration.initializer) &&
      isEncodeURIComponentTarget(checker, declaration.initializer, seen)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Reviewed helpers that turn an open-ended value into a slash-separated,
 * per-segment-encoded path TAIL. The value is dynamic, so the tail is a single
 * marker segment that may bind only the final parameter of a route in
 * {@link REVIEWED_MULTI_SEGMENT_ROUTES}.
 */
const REVIEWED_PATH_TAIL_SANITIZERS: ReadonlyArray<{
  name: string;
  file: string;
}> = [
  {
    // Validated by noteAttachmentKeyAddressable before every call.
    name: "noteAttachmentKeyPath",
    file: `${sep}src${sep}lib${sep}subscriber-profile-api.ts`,
  },
];

/**
 * Routes whose final parameter is registered server-side with a `.+` pattern
 * and so accepts several path segments. The gateway inventory spells them as a
 * plain `{param}`, so each is listed here by hand with its registration.
 */
const REVIEWED_MULTI_SEGMENT_ROUTES: ReadonlySet<string> = new Set([
  // apps/api/internal/subscriber_notes/subscriber_notes.go — {file_key:.+}
  "DELETE /api/v1/subscribers/{id}/notes/{note}/attachments/{file_key}",
]);

const PATH_TAIL_MARKER_PREFIX = `${DYNAMIC_MARKER_PREFIX}TAIL_`;
const PATH_TAIL_MARKER = new RegExp(`^${PATH_TAIL_MARKER_PREFIX}\\d+__$`, "u");

function reviewedPathTailSanitizer(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): string | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const symbol = symbolAt(checker, call.expression);
  const reviewed = REVIEWED_PATH_TAIL_SANITIZERS.find(
    (entry) => entry.name === symbol?.name,
  );
  if (!symbol || !reviewed) return null;
  return (symbol.declarations ?? []).some((declaration) =>
    declaration.getSourceFile().fileName.endsWith(reviewed.file),
  )
    ? reviewed.name
    : null;
}

function reviewedMultiSegmentSanitizer(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): boolean {
  if (!ts.isIdentifier(call.expression)) return false;
  const symbol = symbolAt(checker, call.expression);
  if (symbol?.name !== "mailchimpCompatPath") return false;
  return (symbol.declarations ?? []).some((declaration) =>
    declaration
      .getSourceFile()
      .fileName.endsWith(`${sep}src${sep}lib${sep}mailchimp-compat-api.ts`),
  );
}

class PathEvaluator {
  private marker = 0;

  constructor(private readonly checker: ts.TypeChecker) {}

  evaluate(expression: ts.Expression): Evaluation {
    try {
      return this.evaluateExpression(expression, {
        bindings: new Map(),
        activeSymbols: new Set(),
      });
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private literal(value: string): Evaluation {
    return {
      ok: true,
      variants: [
        appendLiteral(
          {
            value: "",
            dynamics: [],
            terminated: false,
            finiteValue: false,
            bindableSpans: [],
          },
          value,
        ),
      ],
    };
  }

  private dynamic(
    expression: ts.Expression,
    safe: boolean,
    reason: string,
    prefix: string = DYNAMIC_MARKER_PREFIX,
  ): Evaluation {
    const marker = `${prefix}${this.marker++}__`;
    const source = expression.getSourceFile();
    const location = sourceLocation(expression);
    return {
      ok: true,
      variants: [
        {
          value: marker,
          terminated: false,
          finiteValue: false,
          bindableSpans: [],
          dynamics: [
            {
              marker,
              safe,
              expression: expression.getText(source),
              reason,
              file: location.file,
              line: location.line,
            },
          ],
        },
      ],
    };
  }

  private evaluateExpression(
    rawExpression: ts.Expression,
    context: EvaluationContext,
  ): Evaluation {
    const expression = unwrapExpression(rawExpression);

    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return this.literal(expression.text);
    }
    if (ts.isNumericLiteral(expression)) return this.literal(expression.text);
    if (
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return this.literal(
        expression.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false",
      );
    }
    if (expression.kind === ts.SyntaxKind.NullKeyword)
      return this.literal("null");

    if (ts.isTemplateExpression(expression)) {
      let variants = this.literal(expression.head.text);
      if (!variants.ok) return variants;
      for (const span of expression.templateSpans) {
        if (!variants.variants.every((variant) => variant.terminated)) {
          const substitution = this.evaluateExpression(
            span.expression,
            context,
          );
          if (!substitution.ok) return substitution;
          variants = {
            ok: true,
            variants: combine(variants.variants, substitution.variants),
          };
        }
        variants = {
          ok: true,
          variants: variants.variants.map((variant) =>
            appendLiteral(variant, span.literal.text),
          ),
        };
      }
      return { ok: true, variants: dedupeVariants(variants.variants) };
    }

    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = this.evaluateExpression(expression.left, context);
      if (!left.ok) return left;
      if (left.variants.every((variant) => variant.terminated)) return left;
      const right = this.evaluateExpression(expression.right, context);
      if (!right.ok) return right;
      return { ok: true, variants: combine(left.variants, right.variants) };
    }

    if (ts.isConditionalExpression(expression)) {
      const whenTrue = this.evaluateExpression(expression.whenTrue, context);
      if (!whenTrue.ok) return whenTrue;
      const whenFalse = this.evaluateExpression(expression.whenFalse, context);
      if (!whenFalse.ok) return whenFalse;
      return {
        ok: true,
        variants: dedupeVariants([...whenTrue.variants, ...whenFalse.variants]),
      };
    }

    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      const left = this.evaluateExpression(expression.left, context);
      if (!left.ok) return left;
      const right = this.evaluateExpression(expression.right, context);
      if (!right.ok) return right;
      return {
        ok: true,
        variants: dedupeVariants([...left.variants, ...right.variants]),
      };
    }

    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(this.checker, expression);
      if (symbol) {
        const bound = context.bindings.get(symbol);
        if (bound) {
          return this.evaluateExpression(bound.expression, bound.context);
        }
        if (context.activeSymbols.has(symbol)) {
          return { ok: false, reason: `cyclic path value ${symbol.name}` };
        }
        for (const declaration of symbol.declarations ?? []) {
          if (
            (ts.isVariableDeclaration(declaration) ||
              ts.isPropertyDeclaration(declaration) ||
              ts.isPropertyAssignment(declaration) ||
              ts.isParameter(declaration)) &&
            declaration.initializer
          ) {
            const next = {
              ...context,
              activeSymbols: new Set(context.activeSymbols).add(symbol),
            };
            return this.narrowToUseSite(
              this.evaluateExpression(declaration.initializer, next),
              this.checker.getTypeAtLocation(expression),
            );
          }
        }
      }
      return this.valueFromType(expression, context);
    }

    if (ts.isPropertyAccessExpression(expression)) {
      const symbol = symbolAt(this.checker, expression.name);
      if (symbol && !context.activeSymbols.has(symbol)) {
        for (const declaration of symbol.declarations ?? []) {
          if (
            (ts.isPropertyAssignment(declaration) ||
              ts.isPropertyDeclaration(declaration)) &&
            declaration.initializer
          ) {
            return this.evaluateExpression(declaration.initializer, {
              ...context,
              activeSymbols: new Set(context.activeSymbols).add(symbol),
            });
          }
        }
      }
      return this.valueFromType(expression, context);
    }

    if (ts.isElementAccessExpression(expression)) {
      return this.valueFromType(expression, context);
    }

    if (ts.isCallExpression(expression)) {
      return this.evaluateCall(expression, context);
    }

    return {
      ok: false,
      reason: `unsupported path expression kind ${ts.SyntaxKind[expression.kind]}`,
    };
  }

  private valueFromType(
    expression: ts.Expression,
    _context: EvaluationContext,
  ): Evaluation {
    const type = this.checker.getTypeAtLocation(expression);
    const finite = finitePrimitiveValues(this.checker, type);
    if (finite != null) {
      return {
        ok: true,
        variants: finite.map((value) => ({
          value,
          dynamics: [],
          terminated: false,
          finiteValue: true,
          bindableSpans: [],
        })),
      };
    }
    if (isDelimiterSafePrimitive(this.checker, type)) {
      return this.dynamic(
        expression,
        true,
        `non-string ${this.checker.typeToString(type)} cannot inject a path delimiter`,
      );
    }
    return this.dynamic(expression, false, "raw string-derived pathname value");
  }

  private narrowToUseSite(result: Evaluation, type: ts.Type): Evaluation {
    if (!result.ok) return result;
    const members = type.isUnion() ? type.types : [type];
    const permitsNull = members.some((member) =>
      Boolean(member.flags & ts.TypeFlags.Null),
    );
    const permitsUndefined = members.some((member) =>
      Boolean(member.flags & ts.TypeFlags.Undefined),
    );
    return {
      ok: true,
      variants: result.variants.filter(
        (variant) =>
          variant.dynamics.length > 0 ||
          ((variant.value !== "null" || permitsNull) &&
            (variant.value !== "undefined" || permitsUndefined)),
      ),
    };
  }

  private evaluateCall(
    call: ts.CallExpression,
    context: EvaluationContext,
  ): Evaluation {
    if (isEncodeURIComponentTarget(this.checker, call.expression)) {
      const argument = call.arguments[0];
      if (!argument) {
        return {
          ok: false,
          reason: "encodeURIComponent path call has no argument",
        };
      }
      const evaluated = this.evaluateExpression(argument, context);
      if (
        evaluated.ok &&
        evaluated.variants.every((variant) => variant.dynamics.length === 0)
      ) {
        return {
          ok: true,
          variants: evaluated.variants.map((variant) => ({
            value: encodeURIComponent(variant.value),
            dynamics: [],
            terminated: false,
            finiteValue: true,
            bindableSpans: [],
          })),
        };
      }
      return this.dynamic(argument, true, "encodeURIComponent path segment");
    }

    if (reviewedMultiSegmentSanitizer(this.checker, call)) {
      const argument = call.arguments[0];
      if (!argument) {
        return {
          ok: false,
          reason: "mailchimpCompatPath has no resource path",
        };
      }
      const evaluated = this.evaluateExpression(argument, context);
      if (!evaluated.ok) return evaluated;
      if (evaluated.variants.some((variant) => variant.dynamics.length > 0)) {
        return {
          ok: false,
          reason:
            "mailchimpCompatPath requires its finite MailchimpCompatResourcePath union",
        };
      }
      return {
        ok: true,
        variants: evaluated.variants.map((variant) => ({
          value: variant.value
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/"),
          dynamics: [],
          terminated: false,
          finiteValue: true,
          bindableSpans: [],
        })),
      };
    }

    const pathTail = reviewedPathTailSanitizer(this.checker, call);
    if (pathTail) {
      const argument = call.arguments[0];
      if (!argument) {
        return { ok: false, reason: `${pathTail} has no path value` };
      }
      return this.dynamic(
        argument,
        true,
        `${pathTail} multi-segment path tail`,
        PATH_TAIL_MARKER_PREFIX,
      );
    }

    if (ts.isIdentifier(call.expression) && call.expression.text === "String") {
      const argument = call.arguments[0];
      if (!argument) return this.literal("");
      const evaluated = this.evaluateExpression(argument, context);
      if (!evaluated.ok) return evaluated;
      return evaluated;
    }

    const declaration = implementationForCall(this.checker, call);
    if (declaration) {
      const symbolTarget = ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name
        : call.expression;
      const symbol = symbolAt(this.checker, symbolTarget);
      if (symbol && context.activeSymbols.has(symbol)) {
        return { ok: false, reason: `recursive path helper ${symbol.name}` };
      }
      const returns = functionBodyReturns(declaration);
      if (!returns || returns.length === 0) {
        return {
          ok: false,
          reason: "path helper has no string return expression",
        };
      }
      const calleeContext: EvaluationContext = {
        bindings: new Map(context.bindings),
        activeSymbols: new Set(context.activeSymbols),
      };
      if (symbol) calleeContext.activeSymbols.add(symbol);
      for (const [index, parameter] of declaration.parameters.entries()) {
        if (!ts.isIdentifier(parameter.name)) continue;
        const parameterSymbol = symbolAt(this.checker, parameter.name);
        if (!parameterSymbol) continue;
        const argument = call.arguments[index];
        if (argument) {
          calleeContext.bindings.set(parameterSymbol, {
            expression: argument,
            context,
          });
        } else if (parameter.initializer) {
          calleeContext.bindings.set(parameterSymbol, {
            expression: parameter.initializer,
            context: calleeContext,
          });
        }
      }
      const variants: StringVariant[] = [];
      for (const returned of returns) {
        const result = this.evaluateExpression(returned, calleeContext);
        if (!result.ok) return result;
        variants.push(...result.variants);
      }
      return { ok: true, variants: dedupeVariants(variants) };
    }

    return this.valueFromType(call, context);
  }
}

function callLocation(
  sourceRoot: string,
  expression: ts.Expression,
): { file: string; line: number } {
  const location = sourceLocation(expression);
  return {
    file: relative(sourceRoot, location.file).split(sep).join("/"),
    line: location.line,
  };
}

function normalizedPath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function resolvedPath(variant: StringVariant): ResolvedApiPath {
  const value = normalizedPath(variant.value);
  const bindableSegments: number[] = [];
  let start = value.startsWith("/") ? 1 : 0;
  const segments = pathSegments(value);
  for (const [index, segment] of segments.entries()) {
    const end = start + segment.length;
    if (
      variant.bindableSpans.some((span) => span.start < end && span.end > start)
    ) {
      bindableSegments.push(index);
    }
    start = end + 1;
  }
  return { value, bindableSegments };
}

export function auditApiClientCalls(
  program: ts.Program,
  sourceRoot: string,
  options: { apiModulePath?: string } = {},
): ApiClientCallAudit {
  const checker = program.getTypeChecker();
  const evaluator = new PathEvaluator(checker);
  const calls: ApiClientCall[] = [];
  const unresolved: ApiClientCallIssue[] = [];
  const unsafeDynamicSegments: ApiClientCallIssue[] = [];
  const normalizedSourceRoot = resolve(sourceRoot);
  const rootPrefix = normalizedSourceRoot.endsWith(sep)
    ? normalizedSourceRoot
    : `${normalizedSourceRoot}${sep}`;
  const apiModulePath = options.apiModulePath
    ? resolve(options.apiModulePath)
    : null;

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !resolve(sourceFile.fileName).startsWith(rootPrefix) ||
      resolve(sourceFile.fileName).includes(`${sep}__tests__${sep}`)
    ) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "api" &&
        (!apiModulePath ||
          (
            symbolAt(checker, node.expression.expression)?.declarations ?? []
          ).some(
            (declaration) =>
              resolve(declaration.getSourceFile().fileName) === apiModulePath,
          )) &&
        node.expression.name.text in API_METHODS
      ) {
        const method =
          API_METHODS[node.expression.name.text as keyof typeof API_METHODS];
        const argument = node.arguments[0];
        const location = callLocation(normalizedSourceRoot, node.expression);
        if (!argument) {
          unresolved.push({
            ...location,
            method,
            expression: "<missing>",
            reason: "API call has no pathname argument",
          });
        } else {
          const source = argument.getSourceFile();
          const expressionText = argument.getText(source);
          const result = evaluator.evaluate(argument);
          if (!result.ok) {
            unresolved.push({
              ...location,
              method,
              expression: expressionText,
              reason: result.reason,
            });
          } else {
            const paths = [
              ...new Map(
                result.variants.map((variant) => {
                  const path = resolvedPath(variant);
                  return [
                    `${path.value}\u0000${path.bindableSegments.join(",")}`,
                    path,
                  ];
                }),
              ).values(),
            ].sort((a, b) => a.value.localeCompare(b.value));
            if (
              paths.length === 0 ||
              paths.some(
                (path) =>
                  path.value !== "/api" && !path.value.startsWith("/api/"),
              )
            ) {
              unresolved.push({
                ...location,
                method,
                expression: expressionText,
                reason: `pathname is not statically bounded to /api: ${paths.map((path) => path.value).join(", ") || "<empty>"}`,
              });
            } else {
              const dynamics = result.variants.flatMap(
                (variant) => variant.dynamics,
              );
              calls.push({
                ...location,
                method,
                expression: expressionText,
                paths,
                dynamicUses: dynamics,
              });
              for (const dynamic of dynamics) {
                if (dynamic.safe) continue;
                unsafeDynamicSegments.push({
                  ...location,
                  method,
                  expression: dynamic.expression,
                  reason: `${dynamic.reason}; wrap the segment in encodeURIComponent or narrow it to a reviewed finite literal union`,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const issueKey = (issue: ApiClientCallIssue): string =>
    `${issue.file}:${issue.line} ${issue.method} ${issue.expression} — ${issue.reason}`;
  const dedupeIssues = (issues: ApiClientCallIssue[]): ApiClientCallIssue[] =>
    [...new Map(issues.map((issue) => [issueKey(issue), issue])).values()].sort(
      (a, b) => issueKey(a).localeCompare(issueKey(b)),
    );

  return {
    calls: calls.sort((a, b) =>
      `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`),
    ),
    unresolved: dedupeIssues(unresolved),
    unsafeDynamicSegments: dedupeIssues(unsafeDynamicSegments),
  };
}

function pathSegments(path: string): string[] {
  return normalizedPath(path).split("/").slice(1);
}

function routeScore(segments: string[]): number {
  return segments.reduce((score, segment) => {
    if (segment === "{rest}") return score;
    if (/^\{[^}]+\}$/u.test(segment)) return score + 1;
    return score + 4;
  }, segments.length);
}

function candidateMatchesRoute(
  candidate: ResolvedApiPath,
  route: GatewayRoute,
): boolean {
  const candidateSegments = pathSegments(candidate.value);
  const bindableSegments = new Set(candidate.bindableSegments);
  const routeSegments = route.segments;
  for (let index = 0; index < routeSegments.length; index += 1) {
    const expected = routeSegments[index]!;
    if (expected === "{rest}") return index <= candidateSegments.length;
    const actual = candidateSegments[index];
    if (actual == null) return false;
    if (actual.includes(PATH_TAIL_MARKER_PREFIX)) {
      // A multi-segment tail binds only a reviewed route's final parameter,
      // and only when the tail is the whole, final candidate segment.
      return (
        PATH_TAIL_MARKER.test(actual) &&
        /^\{[^}]+\}$/u.test(expected) &&
        index === routeSegments.length - 1 &&
        index === candidateSegments.length - 1 &&
        REVIEWED_MULTI_SEGMENT_ROUTES.has(route.key)
      );
    }
    if (/^\{[^}]+\}$/u.test(expected)) {
      if (
        !actual.includes(DYNAMIC_MARKER_PREFIX) &&
        !bindableSegments.has(index)
      ) {
        return false;
      }
      continue;
    }
    if (actual.includes(DYNAMIC_MARKER_PREFIX) || actual !== expected)
      return false;
  }
  return candidateSegments.length === routeSegments.length;
}

export function compileGatewayRouteMatcher(
  routeKeys: Iterable<string>,
): GatewayRouteMatcher {
  const routes: GatewayRoute[] = [];
  const exact = new Map<string, GatewayRoute[]>();
  for (const key of routeKeys) {
    const separator = key.indexOf(" ");
    if (separator <= 0) throw new Error(`invalid gateway route key ${key}`);
    const method = key.slice(0, separator);
    const path = normalizedPath(key.slice(separator + 1));
    const route: GatewayRoute = {
      key: `${method} ${path}`,
      method,
      path,
      segments: pathSegments(path),
      score: routeScore(pathSegments(path)),
    };
    routes.push(route);
    const exactRoutes = exact.get(path) ?? [];
    exactRoutes.push(route);
    exact.set(path, exactRoutes);
  }
  routes.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  return {
    match(
      method: string,
      rawPath: string | ResolvedApiPath,
    ): MountedRouteMatch {
      const rawValue = typeof rawPath === "string" ? rawPath : rawPath.value;
      const path = normalizedPath(rawValue.split(/[?#]/u, 1)[0] ?? "");
      const candidate: ResolvedApiPath = {
        value: path,
        bindableSegments:
          typeof rawPath === "string" ? [] : rawPath.bindableSegments,
      };
      if (!path.includes(DYNAMIC_MARKER_PREFIX)) {
        const exactRoutes = exact.get(path);
        if (exactRoutes) {
          const allowed = exactRoutes.find(
            (route) => route.method === method || route.method === "ANY",
          );
          return allowed
            ? { mounted: true, route: allowed.key }
            : { mounted: false, route: exactRoutes[0]?.key };
        }
      }

      const matches = routes.filter((route) =>
        candidateMatchesRoute(candidate, route),
      );
      if (matches.length === 0) return { mounted: false };
      const bestScore = matches[0]!.score;
      const mostSpecific = matches.filter((route) => route.score === bestScore);
      const allowed = mostSpecific.find(
        (route) => route.method === method || route.method === "ANY",
      );
      return allowed
        ? { mounted: true, route: allowed.key }
        : { mounted: false, route: mostSpecific[0]?.key };
    },
  };
}

export function formatIssues(issues: ApiClientCallIssue[]): string[] {
  return issues.map(
    (issue) =>
      `${issue.file}:${issue.line} ${issue.method} ${issue.expression} — ${issue.reason}`,
  );
}
