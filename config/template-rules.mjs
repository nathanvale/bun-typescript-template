const localeNames = new Set(["localeCompare", "Collator"]);
const folding = new Set(["TemplateLiteral", "BinaryExpression"]);
const comma = { type: "Literal", value: "," };
const commentDirective =
  /^(?:eslint-|eslint |global |@ts-|biome-ignore|fallow-ignore)/;
const plainMarkers = ["Platform", "Interface"];
const safetyMarker = "SAFETY";
const commentMarker = new RegExp(`^(?:${plainMarkers.join("|")}):`);
const safetyJustification = new RegExp(`^${safetyMarker}:\\s*\\S`);
const acceptedDecision = /accepted decisions?\b/i;
const decisionId = String.raw`\b[A-Z][A-Z0-9]*-?\d+[a-z]?\b`;
const rulingDate = String.raw`\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b`;
const decisionCitation = new RegExp(
  String.raw`[Aa]ccepted\s+decisions?\s+(?:${decisionId}|\([^)]*?(?:${decisionId}|${rulingDate}|\bquestion\s+\d+\b))`,
);
const suppressionReasons = [
  [
    /^(?:eslint-disable(?:-next-line|-line)?|eslint|fallow-ignore(?:-next-line|-file)?)(?=\s|$)/,
    /\s-{2,}\s+\S/,
  ],
  [/^@ts-(?:ignore|expect-error|nocheck)(?=\s|$)/, /^@ts-[\w-]+\s+\S/],
  [/^biome-ignore(?:-all|-start)?(?=\s|$)/, /^biome-ignore\S*\s+[^\s:]+:\s*\S/],
];
const refusals = {
  comment: {
    problem: "A comment reads as permission, and the next agent builds on it.",
    repair: "",
  },
  reason: {
    problem:
      "This suppression gives no reason, so the next agent cannot tell whether it still holds.",
    repair:
      "give the reason after the directive (eslint-disable-next-line rule -- reason, fallow-ignore-next-line kind -- reason, @ts-expect-error reason, biome-ignore lint/group/rule: reason), or fix what it suppresses and ",
  },
  decision: {
    problem:
      "This comment names an accepted decision but cites none, so nobody can find the ruling it claims.",
    repair:
      "cite the decision by its id or ruling date right after the words (accepted decision N4a, or Accepted decision (Nathan, 19 November 2026, 12:08 AEDT), or Accepted decision (Command Contract 3 question 4)); if no ruling exists, ",
  },
};
const castOwners = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function constantText(context, node, depth = 0) {
  if (!node || depth > 8) return undefined;
  return folders[node.type]?.(context, node, depth + 1);
}

function foldAll(context, nodes, depth) {
  const parts = nodes.map((node) => constantText(context, node, depth));
  return parts.includes(undefined) ? undefined : parts;
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

const folders = {
  Literal: (context, node) =>
    typeof node.value === "string" ? node.value : undefined,
  TemplateLiteral(context, node, depth) {
    const parts = foldAll(context, node.expressions, depth);
    return parts
      ?.map((part, index) => node.quasis[index].value.cooked + part)
      .concat(node.quasis.at(-1).value.cooked)
      .join("");
  },
  BinaryExpression(context, node, depth) {
    if (node.operator !== "+") return undefined;
    return foldAll(context, [node.left, node.right], depth)?.join("");
  },
  CallExpression(context, { callee, arguments: args }, depth) {
    const list = callee.property?.name === "join" ? callee.object : undefined;
    if (list?.type !== "ArrayExpression") return undefined;
    const parts = foldAll(
      context,
      [...args, comma].concat(list.elements),
      depth,
    );
    return parts?.slice(args.length + 1).join(parts[0]);
  },
  Identifier(context, node, depth) {
    const definition = findVariable(
      context.sourceCode.getScope(node),
      node.name,
    )?.defs[0];
    const simple =
      definition?.parent?.kind === "const" &&
      definition.node.id === definition.name;
    return simple
      ? constantText(context, definition.node.init, depth)
      : undefined;
  },
};

function outermost(context, node) {
  return (
    !folding.has(node.parent?.type) ||
    constantText(context, node.parent) === undefined
  );
}

const testFolderOwner = "/tests/support/test-folder.ts";
const folderCalls = new Set(["tmpdir", "mkdtemp", "mkdtempSync"]);
const timerPromises = new Set(["node:timers/promises", "timers/promises"]);
const bunSleeps = new Set(["sleep", "sleepSync"]);
const typeWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
const bare = (node) =>
  typeWrappers.has(node?.type) ? bare(node.expression) : node;
const isUndefined = (node) =>
  (node.type === "Identifier" && node.name === "undefined") ||
  (node.type === "UnaryExpression" && node.operator === "void");
const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";
const onlyCall = ({ body }) => {
  const expression =
    body.type === "BlockStatement"
      ? body.body.length === 1 && body.body[0].expression
      : body;
  return expression?.type === "CallExpression" ? expression : undefined;
};
const propertyName = (node) =>
  node.computed
    ? typeof node.property.value === "string"
      ? node.property.value
      : undefined
    : node.property.name;
const lookup = (context, node) => {
  for (
    let scope = context.sourceCode.getScope(node);
    scope;
    scope = scope.upper
  )
    if (scope.set.has(node.name)) return scope.set.get(node.name);
};
const moduleObject = (source) =>
  typeof source?.value === "string"
    ? { module: source.value.replace(/^node:/, "") }
    : undefined;
const memberOf = (base, name) =>
  base?.module && base.name === undefined
    ? { module: base.module, name }
    : { name };
const definitionTracers = {
  ImportBinding: (def) => ({
    module: def.parent.source.value.replace(/^node:/, ""),
    name:
      def.node.type === "ImportSpecifier"
        ? (def.node.imported.name ?? def.node.imported.value)
        : undefined,
  }),
  Variable: (def, node, next) => {
    const { id, init } = def.node;
    if (id === def.name) return next(init) ?? { name: node.name };
    const property = id.properties?.find(
      ({ type, value }) =>
        type === "Property" && (value.left ?? value) === def.name,
    );
    if (!property) return { name: node.name };
    const { key, computed } = property;
    return memberOf(
      next(init),
      key.type === "Literal" ? key.value : computed ? undefined : key.name,
    );
  },
};
const traceIdentifier = (node, next, context) => {
  const def = lookup(context, node)?.defs[0];
  if (!def)
    return node.name === "globalThis"
      ? { module: "global" }
      : node.name === "Bun"
        ? { module: "bun" }
        : { module: "global", name: node.name };
  return definitionTracers[def.type]?.(def, node, next) ?? { name: node.name };
};
const tracers = {
  Identifier: traceIdentifier,
  MemberExpression: (node, next) => {
    const name = propertyName(node);
    return typeof name === "string"
      ? memberOf(next(node.object), name)
      : undefined;
  },
  CallExpression: (node) =>
    node.callee.type === "Identifier" && node.callee.name === "require"
      ? moduleObject(node.arguments[0])
      : undefined,
  ImportExpression: (node) => moduleObject(node.source),
  AwaitExpression: (node, next) => next(node.argument),
  ChainExpression: (node, next) => next(node.expression),
  SequenceExpression: (node, next) => next(node.expressions.at(-1)),
};
const origin = (context, node, depth = 0) => {
  const inner = bare(node);
  return inner && depth < 8
    ? tracers[inner.type]?.(
        inner,
        (next) => origin(context, next, depth + 1),
        context,
      )
    : undefined;
};
const isTimer = (traced, name) =>
  traced?.name === name &&
  (traced.module === "global" || traced.module === "timers");
const executorResolve = (context, node) =>
  context.sourceCode
    .getAncestors(node)
    .findLast(
      (ancestor) =>
        isFunction(ancestor) &&
        ancestor.parent.type === "NewExpression" &&
        ancestor.parent.callee.name === "Promise" &&
        ancestor.parent.arguments[0] === ancestor,
    )?.params[0]?.name;
const noValue = (values) =>
  values.length === 0 || (values.length === 1 && isUndefined(bare(values[0])));
const resolves = ([wrapped, , ...values], resolve) => {
  const callback = bare(wrapped);
  if (callback?.type === "Identifier")
    return callback.name === resolve && noValue(values);
  const call = isFunction(callback) ? onlyCall(callback) : undefined;
  return call?.callee.name === resolve && noValue(call.arguments);
};
const delays = (context, node) => {
  const resolve = executorResolve(context, node);
  return resolve !== undefined && resolves(node.arguments, resolve);
};
const namesNothing = (wrapped) => {
  const node = bare(wrapped);
  return (
    isUndefined(node) ||
    (node.type === "Literal" && node.value === "") ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis[0].value.cooked === "") ||
    (node.regex !== undefined &&
      new RegExp(node.regex.pattern, node.regex.flags).test("\0"))
  );
};

function commentBlocks(source) {
  const blocks = [];
  for (const comment of source.getAllComments()) {
    const block = blocks[blocks.length - 1];
    const last = block?.[block.length - 1];
    if (
      last?.type === "Line" &&
      comment.type === "Line" &&
      comment.loc.start.line === last.loc.end.line + 1
    )
      block.push(comment);
    else blocks.push([comment]);
  }
  return blocks;
}

function isConstAssertion(node) {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function commentAbove(source, node) {
  const comment = source.getCommentsBefore(node).at(-1);
  return comment?.loc.end.line === node.loc.start.line - 1
    ? comment
    : undefined;
}

function castPlacements(source, assertion) {
  const placements = [];
  let node = assertion;
  while (node.parent) {
    placements.push(commentAbove(source, node));
    if (castOwners.has(node.type)) {
      if (
        node.parent.type === "ExportNamedDeclaration" &&
        node.parent.declaration === node
      )
        placements.push(commentAbove(source, node.parent));
      break;
    }
    if (node.parent.type === "Program") break;
    node = node.parent;
  }
  return placements;
}

function givesReason(directive) {
  const found = suppressionReasons.find(([name]) => name.test(directive));
  return found === undefined || found[1].test(directive);
}

function refusalOf(lines) {
  if (commentDirective.test(lines[0])) return refusals.reason;
  if (acceptedDecision.test(lines.join(" "))) return refusals.decision;
  return refusals.comment;
}

function isAdmitted(source, block, placed) {
  const lines = block.map((comment) => comment.value.trim());
  const [first = ""] = lines;
  const { start } = block[0].loc;
  return (
    (commentDirective.test(first) && givesReason(first)) ||
    commentMarker.test(first) ||
    decisionCitation.test(lines.join(" ")) ||
    (safetyJustification.test(first) &&
      source.lines[start.line - 1].slice(0, start.column).trim() === "" &&
      placed.has(block[block.length - 1]))
  );
}

export default {
  rules: {
    "no-comments": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          comment:
            "{{problem}} Keep a comment only when its first word is Platform: (behaviour of a runtime, operating system or tool this repository cannot change) or Interface: (a public contract the types cannot state), or when it cites an accepted decision (AGENTS.md, Authority) by its id or ruling date, or when it is a lint or compiler directive that gives its reason, or when it opens with SAFETY: and a justification, on its own lines directly above the statement that holds a type cast (as T, not as const). Repair: {{repair}}say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.",
        },
      },
      create(context) {
        const source = context.sourceCode;
        const placed = new Set();
        const collect = (node) => {
          if (!isConstAssertion(node))
            for (const comment of castPlacements(source, node))
              placed.add(comment);
        };
        return {
          TSAsExpression: collect,
          TSTypeAssertion: collect,
          "Program:exit"() {
            for (const block of commentBlocks(source)) {
              if (isAdmitted(source, block, placed)) continue;
              context.report({
                loc: {
                  start: block[0].loc.start,
                  end: block[block.length - 1].loc.end,
                },
                messageId: "comment",
                data: refusalOf(block.map((comment) => comment.value.trim())),
              });
            }
          },
        };
      },
    },
    "no-locale-compare": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          locale:
            "localeCompare and Intl.Collator tie distinct keys and follow the runtime collation. Repair: (a, b) => (a < b ? -1 : a > b ? 1 : 0)",
        },
      },
      create(context) {
        const report = (node, name) => {
          if (localeNames.has(name))
            context.report({ node, messageId: "locale" });
        };
        const constant = (node) => {
          if (outermost(context, node))
            report(node, constantText(context, node));
        };
        return {
          "MemberExpression[computed=false]"(node) {
            report(node.property, node.property.name);
          },
          "ObjectPattern > Property[computed=false]"(node) {
            report(node.key, node.key.name);
          },
          Literal: constant,
          TemplateLiteral: constant,
          "BinaryExpression[operator='+']": constant,
          "CallExpression[callee.property.name='join']": constant,
        };
      },
    },
    "require-to-throw-message": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          bare: 'A bare {{name}}() passes whatever is thrown. Repair: pass the message or the cause that the test\'s name gives, as in .toThrow("Duplicate command identity.").',
          empty:
            '{{name}}({{argument}}) names no message, so it passes whatever is thrown. Repair: pass the message or the cause that the test\'s name gives, as in .toThrow("Duplicate command identity.").',
        },
      },
      create(context) {
        return {
          "CallExpression > MemberExpression.callee"(node) {
            const name = propertyName(node);
            if (
              !/^toThrow(?:Error)?$/.test(name) ||
              (node.object.type === "MemberExpression" &&
                propertyName(node.object) === "not")
            )
              return;
            const [argument] = node.parent.arguments;
            if (argument && !namesNothing(argument)) return;
            context.report({
              node: node.property,
              messageId: argument ? "empty" : "bare",
              data: {
                name,
                argument: argument && context.sourceCode.getText(argument),
              },
            });
          },
        };
      },
    },
    "tests-use-test-folder": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          folder:
            "{{name}}() ignores STATE_TEST_DIR, so a run on a chosen filesystem misses this folder. Repair: make the test folder with testFolder(prefix) from tests/support/test-folder.ts.",
        },
      },
      create(context) {
        if (context.filename.replaceAll("\\", "/").endsWith(testFolderOwner))
          return {};
        return {
          CallExpression({ callee }) {
            const name = origin(context, callee)?.name;
            if (folderCalls.has(name))
              context.report({
                node:
                  callee.type === "MemberExpression" ? callee.property : callee,
                messageId: "folder",
                data: { name },
              });
          },
        };
      },
    },
    "tests-no-sleep": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          sleep:
            "{{what}} waits on wall time, so the test passes on a fast machine and fails on a loaded one. Repair: wait on the event the test is about (a ready file, a ledger line, a barrier or the process exit). To bound a wait, race the event against a setTimeout that rejects or aborts.",
        },
      },
      create(context) {
        const report = (node, what) =>
          context.report({ node, messageId: "sleep", data: { what } });
        return {
          "MemberExpression, CallExpression > Identifier.callee"(node) {
            const traced = origin(context, node);
            if (traced?.module === "bun" && bunSleeps.has(traced.name))
              report(node, `Bun.${traced.name}`);
          },
          "ImportSpecifier[imported.name='setTimeout']"(node) {
            if (timerPromises.has(node.parent.source.value))
              report(node, "The node:timers/promises setTimeout");
          },
          "ImportDefaultSpecifier, ImportNamespaceSpecifier"(node) {
            if (timerPromises.has(node.parent.source.value))
              report(node, "The node:timers/promises module");
          },
          "ImportExpression, CallExpression[callee.name='require']"(node) {
            if (origin(context, node)?.module === "timers/promises")
              report(node, "The node:timers/promises module");
          },
          CallExpression(node) {
            if (
              isTimer(origin(context, node.callee), "setTimeout") &&
              delays(context, node)
            )
              report(node, "A promise that setTimeout only resolves");
          },
        };
      },
    },
  },
};
