export const FILE_NAMES = {
  projectState: "project.json",
  cleanedText: "cleaned.txt",
  structure: "structure.json",
  chapterIndex: "chapter_index.json",
  chapterState: "chapter_state.json",
  source: "source.txt",
  narrativeUnits: "narrative_units.json",
  attributedUnits: "attributed_units.json",
  segmentation: "segmentation.json",
  sceneState: "scene_state.json",
  scene: "scene.json",
  mappingInput: "mapping_input.json",
  vnScript: "vn_script.json",
  fidelityReport: "fidelity_report.json",
  visualPrompt: "visual_prompt.json",
  consistencyReport: "consistency_report.json",
  chapterScript: (chapterIndex: number) =>
    `chapter-${String(chapterIndex).padStart(4, "0")}-script.json`,
  fullPreviewScript: "full-preview-script.json",
} as const;

export const DIR_NAMES = {
  raw: "raw",
  normalized: "normalized",
  chapters: "chapters",
  scenes: "scenes",
  scripts: "scripts",
  prompts: "prompts",
  reports: "reports",
  preview: "preview",
  logs: "logs",
} as const;
