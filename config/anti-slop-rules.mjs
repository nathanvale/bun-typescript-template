import { isReassigned } from "./anti-slop-bindings.mjs";
import {
  noUnknownTypeAliases,
  noWidenThenAssert,
} from "./anti-slop-type-rules.mjs";

const upstream = {
  name: "anti-slop",
  source:
    "https://github.com/dmmulroy/anti-slop/tree/13909c9e07590f5a85d93c62712259fe14a883f7/src",
  licence: `MIT License

Copyright (c) 2026 Dillon Mulroy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
};

const assertion = ":matches(TSAsExpression, TSTypeAssertion)";
const outermostAssertion = `${assertion}:not(${assertion} > ${assertion})`;
const constAt = (path) => `[${path}typeAnnotation.typeName.name="const"]`;
const assertionAt = (path) =>
  `[${path}type=/^(?:TSAsExpression|TSTypeAssertion)$/]`;
const chainedMessage =
  "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.";
const chainLevels = [
  "",
  "expression.",
  "expression.expression.",
  "expression.expression.expression.",
];

function chainSelector(constDepth) {
  const consts = chainLevels.slice(0, constDepth).map(constAt).join("");
  const level = chainLevels[constDepth];
  const assertedAt = chainLevels[Math.max(constDepth, 1)];
  return `${outermostAssertion}${consts}${assertionAt(assertedAt)}:not(${constAt(level)})`;
}

const chainedTypeAssertions = [0, 1, 2, 3].map(chainSelector).join(", ");

const noChainedTypeAssertions = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow a chain of type assertions that discards type evidence.",
    },
    messages: { chained: chainedMessage },
  },
  create(context) {
    return {
      [chainedTypeAssertions](node) {
        context.report({ node, messageId: "chained" });
      },
    };
  },
};

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

function resolveVariable(sourceCode, identifier) {
  for (
    let scope = sourceCode.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
  }
  return null;
}

function importedName(node) {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier"
    ? node.imported.name
    : node.imported.value;
}

function isTestFrameworkObject(sourceCode, expression) {
  if (expression.type !== "Identifier") return false;
  const named = expression.name === "vi" || expression.name === "jest";
  if (named && sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) return named;
  return variable.defs.some(isTestFrameworkImport);
}

function isTestFrameworkImport(definition) {
  if (
    definition.type !== "ImportBinding" ||
    definition.parent?.type !== "ImportDeclaration"
  )
    return false;
  const source = definition.parent.source.value;
  const name = importedName(definition.node);
  return (
    (source === "vitest" && name === "vi") ||
    (source === "@jest/globals" && name === "jest")
  );
}

function staticPropertyName(member) {
  const { property } = member;
  if (!member.computed)
    return property.type === "Identifier" ? property.name : null;
  if (property.type === "Literal" && typeof property.value === "string")
    return property.value;
  return property.type === "TemplateLiteral" &&
    property.expressions.length === 0
    ? property.quasis[0].value.cooked
    : null;
}

function moduleMockCall(sourceCode, callee) {
  return (
    callee.type === "MemberExpression" &&
    isTestFrameworkObject(sourceCode, callee.object) &&
    moduleMockMethods.has(staticPropertyName(callee))
  );
}

const noModuleMocking = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super") return;
        if (moduleMockCall(context.sourceCode, node.callee))
          context.report({ node, messageId: "moduleMock" });
      },
    };
  },
};

const arrayWrappers = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

function unwrapArrayExpression(node) {
  let current = node;
  while (arrayWrappers.has(current.type)) current = current.expression;
  return current;
}

function resolveArrayBinding(sourceCode, node) {
  const unwrapped = unwrapArrayExpression(node);
  return unwrapped.type === "Identifier"
    ? resolveVariable(sourceCode, unwrapped)
    : null;
}

function arrayMethodTarget(node) {
  const member = unwrapArrayExpression(node);
  if (member.type !== "MemberExpression") return null;
  const name = staticPropertyName(member);
  return name === null ? null : { name, object: member.object };
}

function isArrayAnnotation(type) {
  if (type.type === "TSArrayType" || type.type === "TSTupleType") return true;
  if (type.type === "TSTypeOperator" && type.operator === "readonly")
    return isArrayAnnotation(type.typeAnnotation);
  return (
    type.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    (type.typeName.name === "Array" || type.typeName.name === "ReadonlyArray")
  );
}

const knownArrayMethods = new Set([
  "map",
  "filter",
  "flatMap",
  "slice",
  "concat",
  "toSorted",
  "toReversed",
  "toSpliced",
]);

function constInitializer(variable) {
  for (const definition of variable.defs)
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator" &&
      definition.node.id.type === "Identifier" &&
      definition.node.init !== null &&
      definition.node.parent.type === "VariableDeclaration" &&
      definition.node.parent.kind === "const"
    )
      return definition.node.init;
  return null;
}

function isKnownArrayExpression(sourceCode, node, visited = new Set()) {
  const unwrapped = unwrapArrayExpression(node);
  if (unwrapped.type === "ArrayExpression") return true;
  if (unwrapped.type === "CallExpression") {
    const method = arrayMethodTarget(unwrapped.callee);
    return (
      method !== null &&
      knownArrayMethods.has(method.name) &&
      isKnownArrayExpression(sourceCode, method.object, visited)
    );
  }
  if (unwrapped.type !== "Identifier") return false;
  const variable = resolveArrayBinding(sourceCode, unwrapped);
  if (variable === null || visited.has(variable)) return false;
  visited.add(variable);
  if (isReassigned(variable)) return false;
  for (const identifier of variable.identifiers) {
    const annotation = identifier.typeAnnotation?.typeAnnotation;
    if (annotation !== undefined) return isArrayAnnotation(annotation);
  }
  const init = constInitializer(variable);
  return init !== null && isKnownArrayExpression(sourceCode, init, visited);
}

const callbackTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

function reducerOf(callback) {
  let owner = callback.parent;
  while (owner && unwrapArrayExpression(owner) === callback)
    owner = owner.parent;
  if (owner?.type !== "CallExpression") return null;
  const method = arrayMethodTarget(owner.callee);
  const [firstArgument] = owner.arguments;
  if (
    method === null ||
    (method.name !== "reduce" && method.name !== "reduceRight") ||
    owner.arguments.length > 2 ||
    firstArgument === undefined ||
    unwrapArrayExpression(firstArgument) !== callback
  )
    return null;
  const [firstParameter] = callback.params;
  const accumulator =
    firstParameter?.type === "AssignmentPattern"
      ? firstParameter.left
      : firstParameter;
  if (accumulator?.type !== "Identifier") return null;
  return { callback, accumulator, initialValue: owner.arguments[1] };
}

function enclosingReducer(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "FunctionDeclaration") return null;
    if (callbackTypes.has(parent.type)) return reducerOf(parent);
  }
  return null;
}

function referencesAccumulator(
  sourceCode,
  node,
  accumulator,
  visited = new Set(),
) {
  const variable = resolveArrayBinding(sourceCode, node);
  if (variable === null || visited.has(variable)) return false;
  if (variable === accumulator) return true;
  visited.add(variable);
  if (isReassigned(variable)) return false;
  const init = constInitializer(variable);
  return (
    init !== null &&
    referencesAccumulator(sourceCode, init, accumulator, visited)
  );
}

function isGlobalCopyOwner(sourceCode, node, name) {
  const unwrapped = unwrapArrayExpression(node);
  if (unwrapped.type !== "Identifier" || unwrapped.name !== name) return false;
  const variable = resolveArrayBinding(sourceCode, unwrapped);
  return variable === null || variable.defs.length === 0;
}

const arrayCopyMethods = new Set([
  "concat",
  "slice",
  "toSpliced",
  "toSorted",
  "toReversed",
  "with",
]);

function copiesAccumulator(sourceCode, node, method, reducer, isAccumulator) {
  if (
    method.name === "assign" &&
    isGlobalCopyOwner(sourceCode, method.object, "Object")
  ) {
    const [target] = node.arguments;
    return (
      target !== undefined &&
      unwrapArrayExpression(target).type === "ObjectExpression" &&
      node.arguments.slice(1).some(isAccumulator)
    );
  }
  if (
    method.name === "from" &&
    isGlobalCopyOwner(sourceCode, method.object, "Array")
  ) {
    const [copied] = node.arguments;
    return copied !== undefined && isAccumulator(copied);
  }
  if (!arrayCopyMethods.has(method.name)) return false;
  const { initialValue } = reducer;
  return (
    initialValue !== undefined &&
    isKnownArrayExpression(sourceCode, initialValue) &&
    isAccumulator(method.object)
  );
}

const noReduceAccumulatorCopy = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow copying growing reducer accumulators with Object.assign, Array.from, or array copy methods.",
    },
    messages: {
      accumulatorCopy:
        "Do not copy the reducer accumulator on every iteration; growing copies can cause quadratic work. Mutate a fresh, locally owned accumulator and return it, or use an iterator pipeline/flatMap.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        const method = arrayMethodTarget(node.callee);
        if (method === null) return;
        const reducer = enclosingReducer(node);
        if (reducer === null) return;
        const accumulator = sourceCode
          .getDeclaredVariables(reducer.callback)
          .find((variable) =>
            variable.identifiers.some(
              (identifier) =>
                identifier.range[0] === reducer.accumulator.range[0],
            ),
          );
        if (accumulator === undefined) return;
        const isAccumulator = (expression) =>
          referencesAccumulator(sourceCode, expression, accumulator);
        if (copiesAccumulator(sourceCode, node, method, reducer, isAccumulator))
          context.report({ node, messageId: "accumulatorCopy" });
      },
    };
  },
};

const typeWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
const loopKeywordLengths = {
  ForStatement: 3,
  ForInStatement: 3,
  ForOfStatement: 3,
  WhileStatement: 5,
  DoWhileStatement: 2,
};
const spreadKinds = { ArrayExpression: "Array", ObjectExpression: "Object" };

function innerExpression(node) {
  let current = node;
  while (typeWrappers.has(current.type)) current = current.expression;
  return current;
}

const contains = (outer, inner) =>
  outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];

function reduceMember(node) {
  if (
    node.type !== "CallExpression" ||
    node.arguments.length < 1 ||
    node.arguments.length > 2
  )
    return null;
  let callee = innerExpression(node.callee);
  if (callee.type === "ChainExpression") callee = callee.expression;
  if (callee.type !== "MemberExpression") return null;
  const name = staticPropertyName(callee);
  return name === "reduce" || name === "reduceRight" ? callee : null;
}

function referencedVariable(sourceCode, identifier) {
  for (
    let scope = sourceCode.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const reference = scope.references.find(
      (candidate) => candidate.identifier === identifier,
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

function bindingIdentifier(parameter) {
  if (parameter?.type === "Identifier") return parameter;
  return parameter?.type === "AssignmentPattern" &&
    parameter.left.type === "Identifier"
    ? parameter.left
    : null;
}

function ownParameters(callback) {
  const [first] = callback.params;
  return first?.type === "Identifier" && first.name === "this"
    ? callback.params.slice(1)
    : callback.params;
}

function nearestFunction(node) {
  for (let current = node.parent; current; current = current.parent)
    if (functionTypes.has(current.type)) return current;
  return null;
}

function enclosingReduceCall(callback) {
  for (
    let child = callback, current = callback.parent;
    current && !functionTypes.has(current.type);
    child = current, current = current.parent
  ) {
    const member = reduceMember(current);
    if (member !== null)
      return current.arguments[0] === child ? { call: current, member } : null;
  }
  return null;
}

function reduceSpread(definition, spread) {
  if (definition.type !== "Parameter") return null;
  const callback = definition.node;
  if (
    bindingIdentifier(ownParameters(callback)[0]) !== definition.name ||
    nearestFunction(spread) !== callback
  )
    return null;
  const reduce = enclosingReduceCall(callback);
  if (reduce === null) return null;
  const [, initialValue] = reduce.call.arguments;
  const initial =
    initialValue === undefined ? null : innerExpression(initialValue);
  return {
    node: reduce.member.property,
    messageId: `reduce${spreadKinds[initial?.type] ?? "Unknown"}`,
  };
}

function assignmentHolding(variable, spread) {
  for (const reference of variable.references) {
    const parent = reference.identifier.parent;
    if (
      reference.isWrite() &&
      parent.type === "AssignmentExpression" &&
      parent.left === reference.identifier &&
      contains(parent.right, spread)
    )
      return parent;
  }
  return null;
}

function loopSpread(definition, variable, spread) {
  if (definition.type !== "Variable" || definition.parent.kind !== "let")
    return null;
  const assignment = assignmentHolding(variable, spread);
  if (assignment === null) return null;
  const right = innerExpression(assignment.right);
  const kind = contains(right, spread) ? spreadKinds[right.type] : undefined;
  if (kind === undefined) return null;
  for (let current = spread.parent; current; current = current.parent)
    if (
      Object.hasOwn(loopKeywordLengths, current.type) &&
      !contains(current, definition.parent)
    )
      return { loop: current, messageId: `loop${kind}` };
  return null;
}

const accumulatingNote =
  "Using spreads within accumulators leads to `O(n^2)` time complexity.";
const reduceSummary = "Do not spread accumulators in Array.prototype.reduce().";
const loopSummary = "Do not spread accumulators in loops.";

const noAccumulatingSpread = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Prevents using object or array spreads on accumulators in `Array.prototype.reduce()` and in loops.",
      url: "https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-accumulating-spread.html",
    },
    messages: {
      reduceArray: `${reduceSummary} It looks like you're spreading an \`Array\`. Consider using the \`Array.push\` or \`Array.concat\` methods to mutate the accumulator instead. ${accumulatingNote}`,
      reduceObject: `${reduceSummary} It looks like you're spreading an \`Object\`. Consider using the \`Object.assign\` or assignment operators to mutate the accumulator instead. ${accumulatingNote}`,
      reduceUnknown: `${reduceSummary} Consider using \`Object.assign()\` or \`Array.prototype.push()\` to mutate the accumulator instead. ${accumulatingNote}`,
      loopArray: `${loopSummary} Consider using \`Array.prototype.push()\` to mutate the accumulator instead. ${accumulatingNote}`,
      loopObject: `${loopSummary} Consider using \`Object.assign()\` to mutate the accumulator instead. ${accumulatingNote}`,
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      SpreadElement(spread) {
        if (
          spread.argument.type !== "Identifier" ||
          !Object.hasOwn(spreadKinds, spread.parent.type)
        )
          return;
        const variable = referencedVariable(sourceCode, spread.argument);
        const [definition] = variable?.defs ?? [];
        if (definition === undefined) return;
        const reduce = reduceSpread(definition, spread);
        if (reduce !== null) context.report(reduce);
        const looped = loopSpread(definition, variable, spread);
        if (looped === null) return;
        const start = looped.loop.range[0];
        context.report({
          loc: {
            start: sourceCode.getLocFromIndex(start),
            end: sourceCode.getLocFromIndex(
              start + loopKeywordLengths[looped.loop.type],
            ),
          },
          messageId: looped.messageId,
        });
      },
    };
  },
};

export default {
  meta: upstream,
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertions,
    "no-widen-then-assert": noWidenThenAssert,
    "no-unknown-type-aliases": noUnknownTypeAliases,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopy,
    "no-module-mocking": noModuleMocking,
    "no-accumulating-spread": noAccumulatingSpread,
  },
};
