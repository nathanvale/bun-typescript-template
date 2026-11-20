import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const mapFile = "GLOSSARY-MAP.md";
const linkPattern = /\]\(([^)\s#]+)(?:#([^)\s]*))?[^)\s]*\)/g;
const termLine = /^\*\*(.+)\*\*:$/m;

type Link = { readonly path: string; readonly fragment: string | undefined };

function localLinks(text: string): Link[] {
  return [...text.matchAll(linkPattern)].flatMap(([, target = "", fragment]) =>
    /^[a-z]+:/i.test(target) ? [] : [{ path: target, fragment }],
  );
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function ownerRowsBelowHeader(map: string): string[][] {
  return map
    .split("\n")
    .filter((line) => /^\s*\|/.test(line))
    .map(tableCells)
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)))
    .slice(1);
}

function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function anchorsIn(text: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] !== undefined) anchors.add(anchorOf(heading[1]));
  }
  return anchors;
}

function isFile(root: string, path: string): boolean {
  return existsSync(join(root, path)) && statSync(join(root, path)).isFile();
}

function linkProblems(links: readonly Link[], root: string): string[] {
  return links.flatMap(({ path, fragment }) => {
    if (!existsSync(join(root, path)))
      return [
        `${mapFile} points to ${path}, which does not exist. Repair: correct the link, or remove its row.`,
      ];
    if (fragment === undefined || fragment === "" || !path.endsWith(".md"))
      return [];
    if (!isFile(root, path)) return [];
    const text = readFileSync(join(root, path), "utf8");
    return anchorsIn(text).has(fragment.toLowerCase())
      ? []
      : [
          `${mapFile} points to ${path}#${fragment}, and ${path} has no heading with that anchor. Repair: correct the anchor, or drop it.`,
        ];
  });
}

function nameProblems(owner: string, owners: Set<string>): string[] {
  const key = owner.toLowerCase();
  const seen = owners.has(key);
  owners.add(key);
  if (owner === "")
    return [
      `${mapFile} has a row with no owner name in its first cell. Repair: name the glossary or project that owns those words.`,
    ];
  return seen
    ? [
        `${mapFile} lists the owner "${owner}" in two rows, so its words have two owners. Repair: merge the rows.`,
      ]
    : [];
}

function targetProblems(
  owner: string,
  path: string,
  ownsWords: boolean,
  root: string,
): string[] {
  if (!/(?:^|\/)GLOSSARY\.md$/.test(path))
    return ownsWords
      ? [
          `${mapFile} makes "${owner}" the owner of ${path}, which is not a GLOSSARY.md file. Repair: point the row at the glossary that defines its words, or begin its Owns cell with "No word".`,
        ]
      : [];
  return isFile(root, path) &&
    !termLine.test(readFileSync(join(root, path), "utf8"))
    ? [
        `${mapFile} makes "${owner}" the owner of ${path}, which defines no term. Repair: point the row at the glossary that defines its words.`,
      ]
    : [];
}

function fileProblems(
  owner: string,
  path: string,
  ownsWords: boolean,
  files: Map<string, string>,
  root: string,
): string[] {
  const held = files.get(path);
  files.set(path, owner);
  const shared =
    held !== undefined && held !== owner
      ? [
          `${mapFile} gives ${path} to both "${held}" and "${owner}". Repair: keep the row of the one that owns it.`,
        ]
      : [];
  return [...shared, ...targetProblems(owner, path, ownsWords, root)];
}

function ownerProblems(map: string, root: string): string[] {
  const owners = new Set<string>();
  const files = new Map<string, string>();
  return ownerRowsBelowHeader(map).flatMap(
    ([owner = "", owns = "", ...rest]) => [
      ...nameProblems(owner, owners),
      ...localLinks([owns, ...rest].join(" ")).flatMap(({ path }) =>
        fileProblems(owner, path, !/^no word\b/i.test(owns), files, root),
      ),
    ],
  );
}

export function mapProblems(map: string, root: string): string[] {
  const links = localLinks(map);
  if (links.length === 0)
    return [
      `${mapFile} points to no glossary file, so this check would check nothing. Repair: link each glossary it names.`,
    ];
  const ownGlossary = links.some(({ path }) => path === "GLOSSARY.md");
  return [
    ...(ownGlossary
      ? []
      : [
          `${mapFile} does not link this repository's own GLOSSARY.md, so it names no glossary that this check can read. Repair: link GLOSSARY.md in the row of the glossary that owns this repository's words.`,
        ]),
    ...linkProblems(links, root),
    ...ownerProblems(map, root),
  ];
}
