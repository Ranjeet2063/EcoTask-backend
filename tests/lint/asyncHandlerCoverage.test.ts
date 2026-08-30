import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Static enforcement for "every async Express handler is wrapped in
 * asyncHandler". A custom ESLint rule was considered first, but this
 * codebase's routers register handlers indirectly (controller functions
 * imported by name, middleware factories like `perUserLimiter` and
 * `createAuthMiddleware` that *return* the actual handler) — an ESLint rule
 * operating file-by-file without type information cannot reliably follow
 * those factory returns without heavy false positives/negatives. Walking
 * the TypeScript AST directly (using the `typescript` package already a
 * devDependency) lets us look at the same handler-shaped functions an
 * ESLint rule would, but with a simpler, precise, single-purpose check that
 * is easy to reason about and to extend.
 *
 * Heuristic: any `async` function/arrow whose first parameter is named
 * `req`/`_req` or typed `Request` is "handler-shaped". Every handler-shaped
 * async function must be the direct argument of a call to `asyncHandler`.
 */

const SRC_ROOT = path.resolve(__dirname, '../../src');
const SCAN_DIRS = ['controllers', 'middleware', 'routes'];

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

function isAsyncFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclarationBase {
  const isFnLike =
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
  if (!isFnLike) return false;
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function isHandlerShaped(fn: ts.FunctionLikeDeclarationBase): boolean {
  const [first] = fn.parameters;
  if (!first) return false;
  const name = first.name.getText();
  if (name === 'req' || name === '_req') return true;
  const typeText = first.type?.getText() ?? '';
  return /\bRequest\b/.test(typeText);
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function isWrappedInAsyncHandler(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.some((arg) => arg === node)) return false;
  return calleeName(parent.expression) === 'asyncHandler';
}

interface Violation {
  file: string;
  line: number;
}

function findUnwrappedHandlers(fileName: string, sourceText: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (
      isAsyncFunctionLike(node) &&
      isHandlerShaped(node) &&
      !isWrappedInAsyncHandler(node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({ file: fileName, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe('findUnwrappedHandlers (detector self-test)', () => {
  it('flags a bare exported async controller function', () => {
    const violations = findUnwrappedHandlers(
      'sample.ts',
      `export async function getThing(req: Request, res: Response) {
        return res.json(await load());
      }`,
    );
    expect(violations).toHaveLength(1);
  });

  it('flags a bare exported async arrow handler', () => {
    const violations = findUnwrappedHandlers(
      'sample.ts',
      `export const getThing = async (req: Request, res: Response) => {
        return res.json(await load());
      };`,
    );
    expect(violations).toHaveLength(1);
  });

  it('flags an inline unwrapped async route handler', () => {
    const violations = findUnwrappedHandlers(
      'sample.ts',
      `router.get('/', async (req, res) => {
        res.json(await load());
      });`,
    );
    expect(violations).toHaveLength(1);
  });

  it('does not flag a handler wrapped in asyncHandler', () => {
    const violations = findUnwrappedHandlers(
      'sample.ts',
      `export const getThing = asyncHandler(async (req: Request, res: Response) => {
        return res.json(await load());
      });`,
    );
    expect(violations).toHaveLength(0);
  });

  it('does not flag a middleware factory returning an asyncHandler-wrapped function', () => {
    const violations = findUnwrappedHandlers(
      'sample.ts',
      `export function perUserLimiter(options) {
        return asyncHandler(async (req, res, next) => {
          next();
        });
      }`,
    );
    expect(violations).toHaveLength(0);
  });

  it('does not flag a synchronous handler', () => {
    const violations = findUnwrappedHandlers(
      'sample.ts',
      `export function verify(req: Request, res: Response) {
        return res.json({ user: req.user });
      }`,
    );
    expect(violations).toHaveLength(0);
  });

  it('does not flag an async helper that is not Express-handler-shaped', () => {
    const violations = findUnwrappedHandlers(
      'sample.ts',
      `async function checkSubmissionEligibility(tx, taskId, userId) {
        return tx.task.findUnique({ where: { id: taskId } });
      }`,
    );
    expect(violations).toHaveLength(0);
  });
});

describe('every async Express handler under src/controllers, src/middleware, src/routes is wrapped in asyncHandler', () => {
  const violations: Violation[] = [];

  for (const dir of SCAN_DIRS) {
    const absDir = path.join(SRC_ROOT, dir);
    for (const file of listTsFiles(absDir)) {
      const text = fs.readFileSync(file, 'utf8');
      violations.push(...findUnwrappedHandlers(file, text));
    }
  }

  it('has no unwrapped async route/middleware handlers', () => {
    const formatted = violations.map(
      (v) => `${path.relative(process.cwd(), v.file)}:${v.line}`,
    );
    expect(formatted).toEqual([]);
  });
});
