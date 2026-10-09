import { describe, it, expect } from "vitest";
import {
  resolveProjectStyle,
  detectGenreHint,
  styleForGenre,
} from "@novel2gal/agents";

/**
 * Project-level genre detection (zero tokens — pure regex, no LLM).
 *
 * Contract under test:
 * - genre is detected ONCE per project (project title + chapter-text
 *   sample); chapter titles NEVER participate;
 * - explicit visualStyleTemplate wins over everything (user override);
 * - a persisted genreHint short-circuits detection (second chapter of the
 *   same project reuses it, so one project keeps one genre);
 * - fresh detections return genreHint for the caller to persist.
 */

// Same project, two different chapters (different titles + different text).
// School keywords appear in BOTH samples (not the titles) so detection is
// sample-driven and stable across the two chapters.
const PROJECT_TITLE = "我的恋爱故事";
const CHAPTER_A_TEXT = "林晓走进校园，同学小明笑着打招呼，同桌递来一张纸条。";
const CHAPTER_B_TEXT = "放学后教室里空无一人，校花站在讲台上，校草抱着篮球走进来。";

describe("resolveProjectStyle (project-level genre, detect-once)", () => {
  it("same project, different chapters (different chapter titles + text) → same genre", () => {
    const a = resolveProjectStyle({ title: PROJECT_TITLE, config: {} }, CHAPTER_A_TEXT);
    const b = resolveProjectStyle({ title: PROJECT_TITLE, config: {} }, CHAPTER_B_TEXT);
    expect(a.source).toBe("detected");
    expect(b.source).toBe("detected");
    // Both samples carry school vocabulary → same detected genre, same style.
    expect(a.genreHint).toBe("school");
    expect(b.genreHint).toBe("school");
    expect(a.styleTemplate).toBe(b.styleTemplate);
    expect(a.styleTemplate).toBe(styleForGenre("school"));
  });

  it("chapter titles never participate: hostile title cannot flip the genre", () => {
    // A xianxia-flavored chapter TITLE with a school sample must still
    // resolve school — titles are never fed to detectGenreHint.
    const hostileTitle = "修仙宗门渡劫飞升";
    const withTitle = resolveProjectStyle({ title: PROJECT_TITLE, config: {} }, CHAPTER_A_TEXT);
    // Sanity: the hostile string WOULD flip detection if it were used.
    expect(detectGenreHint(hostileTitle, "平淡无奇的日常散步")).toBe("xianxia");
    // But the helper takes no chapter title, so the sample alone decides.
    expect(withTitle.genreHint).toBe("school");
  });

  it("explicit visualStyleTemplate wins over detection (user override)", () => {
    const res = resolveProjectStyle(
      { title: PROJECT_TITLE, config: { visualStyleTemplate: "gothic-fantasy" } },
      CHAPTER_A_TEXT,
    );
    expect(res.source).toBe("explicit");
    expect(res.styleTemplate).toBe("gothic-fantasy");
    // No fresh detection to persist.
    expect(res.genreHint).toBeUndefined();
  });

  it("persisted genreHint short-circuits detection (second chapter reuses it)", () => {
    // First chapter: fresh detection (persists "ancient").
    const first = resolveProjectStyle(
      { title: PROJECT_TITLE, config: {} },
      "王爷走进后宫，皇后娘娘端坐凤椅，太子跪在一旁。",
    );
    expect(first.source).toBe("detected");
    expect(first.genreHint).toBe("ancient");

    // Second chapter reuses the persisted hint even though its own sample
    // would detect something else — one project keeps one genre.
    const second = resolveProjectStyle(
      { title: PROJECT_TITLE, config: { genreHint: first.genreHint } },
      "御剑飞行的仙君落在宗门前，灵气涌动，金丹大成。",
    );
    expect(second.source).toBe("explicit");
    expect(second.genreHint).toBeUndefined();
    expect(second.styleTemplate).toBe(styleForGenre("ancient"));
    expect(second.styleTemplate).not.toBe(styleForGenre("xianxia"));
  });

  it("'default' template is not explicit — falls through to detection", () => {
    const res = resolveProjectStyle(
      { title: PROJECT_TITLE, config: { visualStyleTemplate: "default" } },
      CHAPTER_A_TEXT,
    );
    expect(res.source).toBe("detected");
    expect(res.genreHint).toBe("school");
  });

  it("null/empty project → modern default (no crash)", () => {
    expect(resolveProjectStyle(null, "").source).toBe("detected");
    expect(resolveProjectStyle(null, "").styleTemplate).toBe(styleForGenre("modern"));
    expect(resolveProjectStyle(undefined).genreHint).toBe("modern");
  });
});
