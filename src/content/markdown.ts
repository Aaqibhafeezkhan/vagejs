import { Marked } from "marked";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { VageError } from "../core/errors.js";

const frontmatterSchema = z.looseObject({
  title: z.string().min(1, "title is required"),
  description: z.string().min(1).optional(),
  draft: z.boolean().default(false),
  layout: z.string().regex(/^[\w-]+$/, "layout must be a file name without extension").optional(),
});

export type Frontmatter = z.output<typeof frontmatterSchema>;

export interface MarkdownPage {
  frontmatter: Frontmatter;
  /** Rendered HTML of the Markdown body. */
  html: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const marked = new Marked({ gfm: true });

export function parseMarkdown(source: string, file: string): MarkdownPage {
  const match = FRONTMATTER_RE.exec(source);
  let data: unknown = {};
  if (match) {
    try {
      data = parseYaml(match[1] ?? "") ?? {};
    } catch (err) {
      throw new VageError(`Invalid YAML frontmatter: ${(err as Error).message}`, file);
    }
  }
  const result = frontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new VageError(`Invalid frontmatter:\n${z.prettifyError(result.error)}`, file);
  }
  const body = match ? source.slice(match[0].length) : source;
  return { frontmatter: result.data, html: marked.parse(body, { async: false }) };
}
