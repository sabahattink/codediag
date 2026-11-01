import { Node } from "ts-morph";

/**
 * A webhook handler authenticates the sender by verifying a signature, not a
 * session: Stripe's constructEvent(), Svix's verify(), a helper such as
 * verifyGithubSignature() or a verifySlackSignature middleware, or an HMAC
 * compared with timingSafeEqual(). Such a route has no user and needs none.
 */
const WEBHOOK_SIGNATURE =
  /\bconstructEvent(?:Async)?\b|\btimingSafeEqual\b|\b(?:verify|validate|check)\w*(?:webhook|signature|hmac)\w*\b|\bisValid\w*Signature\b|\b(?:wh|webhook\w*|svix\w*)\.verify\s*\(|\bnew\s+Webhook\s*\([^)]*\)\s*\.verify\s*\(/i;

/** Whether source text verifies a webhook signature. */
export function verifiesWebhookSignature(source: string): boolean {
  return WEBHOOK_SIGNATURE.test(source);
}

/**
 * A handler's source: the function itself, or the function a name or
 * property refers to, followed through imports. Falls back to the node's
 * own text when the declaration cannot be resolved.
 */
export function handlerSource(node: Node): string {
  if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) {
    return node.getText();
  }
  const symbol = node.getSymbol();
  const target = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
  const declaration = target?.getDeclarations()[0];
  if (!declaration) return node.getText();
  const value = Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : declaration;
  return `${node.getText()} ${value?.getText() ?? ""}`;
}
