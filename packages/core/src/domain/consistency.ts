export type ConsistencyIssueType =
  | "character_name_conflict"
  | "alias_conflict"
  | "background_label_conflict"
  | "scene_label_conflict"
  | "prompt_style_drift";

export interface ConsistencyIssue {
  issueId: string;
  type: ConsistencyIssueType;
  message: string;
  relatedIds?: string[];
  suggestion?: string;
}

export interface ConsistencyReport {
  projectId: string;
  issues: ConsistencyIssue[];
  generatedAt: string;
}
