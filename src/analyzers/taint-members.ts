import {
  type ClassDeclaration,
  type ClassExpression,
  type ConstructorDeclaration,
  Node,
  type PropertyAccessExpression,
  SyntaxKind,
} from "ts-morph";
import { add } from "./taint.js";

/**
 * Object state for taint tracking: the values a class stores in a field of
 * `this`, found by syntax within the class body. Instances are not told
 * apart, so a field holds request data when any member of its class stores
 * request data in it, or any `new` expression passes request data for the
 * constructor parameter that sets it.
 */

type ClassLike = ClassDeclaration | ClassExpression;

/** One place a class sets a field of `this`. */
export interface MemberWrite {
  /** The assignment, property declaration, or parameter property. */
  node: Node;
  /** The stored value; absent for a constructor parameter property. */
  value?: Node;
  /** A parameter property: the constructor and the parameter's position. */
  parameter?: { fn: ConstructorDeclaration; index: number };
  /** The method, constructor, or accessor that writes; none for fields. */
  member?: Node;
}

const classWrites = new WeakMap<ClassLike, Map<string, MemberWrite[]>>();

/**
 * The class member whose `this` a node sees. Arrow functions keep the `this`
 * of their enclosing member; plain functions and object literal methods have
 * their own.
 */
function thisMember(node: Node): Node | undefined {
  for (let current = node.getParent(); current; current = current.getParent()) {
    if (
      Node.isMethodDeclaration(current) ||
      Node.isConstructorDeclaration(current) ||
      Node.isGetAccessorDeclaration(current) ||
      Node.isSetAccessorDeclaration(current) ||
      Node.isPropertyDeclaration(current)
    ) {
      const owner = current.getParent();
      return Node.isClassDeclaration(owner) || Node.isClassExpression(owner)
        ? current
        : undefined;
    }
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isClassDeclaration(current) ||
      Node.isClassExpression(current) ||
      Node.isClassStaticBlockDeclaration(current)
    ) {
      return undefined;
    }
  }
  return undefined;
}

function thisClass(member: Node | undefined): ClassLike | undefined {
  const owner = member?.getParent();
  return Node.isClassDeclaration(owner) || Node.isClassExpression(owner)
    ? owner
    : undefined;
}

/** Indexes a class once: every field write, keyed by field name. */
function indexClass(owner: ClassLike): Map<string, MemberWrite[]> {
  const cached = classWrites.get(owner);
  if (cached) return cached;

  const writes = new Map<string, MemberWrite[]>();
  for (const property of owner.getProperties()) {
    const value = property.getInitializer();
    if (value && !property.isStatic()) {
      add(writes, property.getName(), { node: property, value });
    }
  }
  for (const fn of owner.getConstructors()) {
    if (!fn.hasBody()) continue;
    fn.getParameters().forEach((parameter, index) => {
      if (parameter.isParameterProperty()) {
        add(writes, parameter.getName(), {
          node: parameter,
          parameter: { fn, index },
          member: fn,
        });
      }
    });
  }
  for (const binary of owner.getDescendantsOfKind(
    SyntaxKind.BinaryExpression,
  )) {
    const target = binary.getLeft();
    if (
      binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken ||
      !Node.isPropertyAccessExpression(target) ||
      !Node.isThisExpression(target.getExpression())
    ) {
      continue;
    }
    const member = thisMember(target);
    if (thisClass(member) !== owner) continue;
    add(writes, target.getName(), {
      node: binary,
      value: binary.getRight(),
      member,
    });
  }
  classWrites.set(owner, writes);
  return writes;
}

/** True when a statement-level write runs on every path to `read`. */
function precedes(write: MemberWrite, read: Node): boolean {
  const statement = write.node.getParent();
  const block = statement?.getParent();
  return (
    Node.isExpressionStatement(statement) &&
    block !== undefined &&
    statement.getEnd() <= read.getStart() &&
    block.getStart() <= read.getStart() &&
    read.getEnd() <= block.getEnd()
  );
}

/**
 * The writes whose value `this.name` can hold where it is read. A write in
 * the reading member that runs before the read on every path overrides the
 * writes elsewhere in the class: `this.dir = "/srv"; readdir(this.dir)`.
 */
export function memberWrites(access: PropertyAccessExpression): MemberWrite[] {
  const member = thisMember(access);
  const owner = thisClass(member);
  if (!owner) return [];
  const writes = indexClass(owner).get(access.getName()) ?? [];
  const local = writes.filter((write) => write.member === member);
  const last = local.filter((write) => precedes(write, access)).at(-1);
  if (!last) return writes;
  return local.filter(
    (write) =>
      write.node.getStart() >= last.node.getStart() &&
      write.node.getEnd() <= access.getStart(),
  );
}
