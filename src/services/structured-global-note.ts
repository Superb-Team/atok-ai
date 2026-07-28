import { isUsefulGroundedTitle } from "./recording-note-metadata.ts";

export interface StructuredActionItem {
  action: string;
  owner: string;
  deadline: string;
  evidence: string;
}

export interface StructuredGlobalNote {
  title: string;
  title_evidence: string[];
  summary: string;
  key_points: string[];
  decisions: string[];
  action_items: StructuredActionItem[];
}

export const STRUCTURED_GLOBAL_NOTE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "meeting_note_front_matter",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 8, maxLength: 90 },
        title_evidence: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: { type: "string", minLength: 8, maxLength: 280 },
        },
        summary: { type: "string", minLength: 1, maxLength: 1_200 },
        key_points: {
          type: "array",
          maxItems: 15,
          items: { type: "string", minLength: 1, maxLength: 280 },
        },
        decisions: {
          type: "array",
          maxItems: 15,
          items: { type: "string", minLength: 1, maxLength: 280 },
        },
        action_items: {
          type: "array",
          maxItems: 15,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", minLength: 1, maxLength: 240 },
              owner: { type: "string", minLength: 1, maxLength: 80 },
              deadline: { type: "string", minLength: 1, maxLength: 80 },
              evidence: { type: "string", minLength: 8, maxLength: 400 },
            },
            required: ["action", "owner", "deadline", "evidence"],
          },
        },
      },
      required: [
        "title",
        "title_evidence",
        "summary",
        "key_points",
        "decisions",
        "action_items",
      ],
    },
  },
} as const;

const LIMITS = {
  title: 90,
  summary: 1_200,
  point: 280,
  action: 240,
  owner: 80,
  deadline: 80,
  evidence: 400,
  titleEvidence: 280,
  items: 15,
} as const;

function normalizeEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

const TITLE_TOPIC_STOP_WORDS = new Set([
  "yang", "dan", "atau", "dari", "untuk", "pada", "dengan", "dalam", "ini", "itu",
  "the", "and", "for", "from", "with", "this", "that", "meeting", "rapat", "catatan",
  "recording", "rekaman", "pembahasan", "diskusi", "update", "status", "data", "sistem",
  "system", "format", "teknis", "technical",
]);

function titleTopicWords(value: string): Set<string> {
  return new Set(
    normalizeEvidence(value)
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.filter((word) => word.length >= 4 && !TITLE_TOPIC_STOP_WORDS.has(word)) ?? [],
  );
}

function expectPlainString(
  value: unknown,
  field: string,
  maxLength: number,
  minLength = 1,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength || /[\r\n]/u.test(trimmed)) {
    throw new Error(`${field} has an invalid length or contains a line break`);
  }
  return trimmed;
}

function expectStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > LIMITS.items) {
    throw new Error(`${field} must be an array with at most ${LIMITS.items} items`);
  }
  const items = value.map((item, index) =>
    expectPlainString(item, `${field}[${index}]`, LIMITS.point));
  const unique = new Set(items.map(normalizeEvidence));
  if (unique.size !== items.length) {
    throw new Error(`${field} contains duplicate items`);
  }
  return items;
}

function expectExactKeys(
  value: Record<string, unknown>,
  field: string,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} contains missing or unexpected fields`);
  }
}

function parseActionItems(
  value: unknown,
  source: string,
  language: string,
): StructuredActionItem[] {
  if (!Array.isArray(value) || value.length > LIMITS.items) {
    throw new Error(`action_items must contain at most ${LIMITS.items} items`);
  }
  const normalizedSource = normalizeEvidence(source);
  const unassigned = language === "id" ? "belum ditugaskan" : "unassigned";
  const unspecified = language === "id" ? "tidak ditentukan" : "not specified";

  const actions = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`action_items[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    expectExactKeys(record, `action_items[${index}]`, [
      "action",
      "owner",
      "deadline",
      "evidence",
    ]);
    const action = expectPlainString(record.action, `action_items[${index}].action`, LIMITS.action);
    const owner = expectPlainString(record.owner, `action_items[${index}].owner`, LIMITS.owner);
    const deadline = expectPlainString(
      record.deadline,
      `action_items[${index}].deadline`,
      LIMITS.deadline,
    );
    const evidence = expectPlainString(
      record.evidence,
      `action_items[${index}].evidence`,
      LIMITS.evidence,
      8,
    );
    const normalizedEvidence = normalizeEvidence(evidence);
    if (!normalizedSource.includes(normalizedEvidence)) {
      throw new Error(`action_items[${index}].evidence is not an exact source span`);
    }
    if (
      normalizeEvidence(owner) !== unassigned &&
      !normalizedEvidence.includes(normalizeEvidence(owner))
    ) {
      throw new Error(`action_items[${index}].owner is not present in its evidence`);
    }
    if (
      normalizeEvidence(deadline) !== unspecified &&
      !normalizedEvidence.includes(normalizeEvidence(deadline))
    ) {
      throw new Error(`action_items[${index}].deadline is not present in its evidence`);
    }
    return { action, owner, deadline, evidence };
  });

  const uniqueActions = new Set(actions.map((item) => normalizeEvidence(item.action)));
  if (uniqueActions.size !== actions.length) {
    throw new Error("action_items contains duplicate actions");
  }
  return actions;
}

function parseTitleEvidence(value: unknown, title: string, source: string): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    throw new Error("title_evidence must contain 2-3 exact source spans");
  }
  const normalizedSource = normalizeEvidence(source);
  const titleWords = titleTopicWords(title);
  const coveredTitleWords = new Set<string>();
  const evidence = value.map((item, index) => {
    const span = expectPlainString(
      item,
      `title_evidence[${index}]`,
      LIMITS.titleEvidence,
      8,
    );
    const normalizedSpan = normalizeEvidence(span);
    if (!normalizedSource.includes(normalizedSpan)) {
      throw new Error(`title_evidence[${index}] is not an exact source span`);
    }
    const overlap = [...titleTopicWords(span)].filter((word) => titleWords.has(word));
    if (overlap.length === 0) {
      throw new Error(`title_evidence[${index}] does not support a title topic`);
    }
    overlap.forEach((word) => coveredTitleWords.add(word));
    return span;
  });
  if (new Set(evidence.map(normalizeEvidence)).size !== evidence.length) {
    throw new Error("title_evidence contains duplicate spans");
  }
  if (coveredTitleWords.size < 2) {
    throw new Error("title is not supported by at least two distinct grounded topic words");
  }
  return evidence;
}

export function parseStructuredGlobalNote(
  raw: string,
  source: string,
  language: string,
): StructuredGlobalNote {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Structured global note is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Structured global note must be an object");
  }
  const record = value as Record<string, unknown>;
  expectExactKeys(record, "structured global note", [
    "title",
    "title_evidence",
    "summary",
    "key_points",
    "decisions",
    "action_items",
  ]);
  const title = expectPlainString(record.title, "title", LIMITS.title, 8);
  if (/^(?:#{1,6}\s|[-*+]\s|>|\|)/u.test(title) || /[*_`[\]]/u.test(title)) {
    throw new Error("title must be plain text without Markdown");
  }
  if (!isUsefulGroundedTitle(title, source)) {
    throw new Error("title is generic, incomplete, or insufficiently grounded");
  }
  return {
    title,
    title_evidence: parseTitleEvidence(record.title_evidence, title, source),
    summary: expectPlainString(record.summary, "summary", LIMITS.summary),
    key_points: expectStringList(record.key_points, "key_points"),
    decisions: expectStringList(record.decisions, "decisions"),
    action_items: parseActionItems(record.action_items, source, language),
  };
}

function escapeTableCell(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}

export function renderStructuredGlobalNote(
  note: StructuredGlobalNote,
  language: string,
): string {
  const labels = language === "id"
    ? {
        summary: "Ringkasan",
        keyPoints: "Poin Utama",
        decisions: "Keputusan",
        actions: "Tindak Lanjut",
        action: "Tindakan",
        owner: "Pemilik",
        deadline: "Tenggat Waktu",
      }
    : {
        summary: "Summary",
        keyPoints: "Key Points",
        decisions: "Decisions",
        actions: "Action Items",
        action: "Action",
        owner: "Owner",
        deadline: "Deadline",
      };

  const sections = [
    `# ${note.title}`,
    `## ${labels.summary}\n\n${note.summary}`,
  ];
  if (note.key_points.length > 0) {
    sections.push(`## ${labels.keyPoints}\n\n${note.key_points.map((point) => `- ${point}`).join("\n")}`);
  }
  if (note.decisions.length > 0) {
    sections.push(`## ${labels.decisions}\n\n${note.decisions.map((decision) => `- ${decision}`).join("\n")}`);
  }
  if (note.action_items.length > 0) {
    const rows = note.action_items.map((item) =>
      `| ${escapeTableCell(item.action)} | ${escapeTableCell(item.owner)} | ${escapeTableCell(item.deadline)} |`);
    sections.push([
      `## ${labels.actions}`,
      "",
      `| ${labels.action} | ${labels.owner} | ${labels.deadline} |`,
      "| --- | --- | --- |",
      ...rows,
    ].join("\n"));
  }
  return sections.join("\n\n");
}
