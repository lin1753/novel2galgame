export type FidelityIssueSeverity = "minor" | "major" | "critical";

export type FidelityIssueType =
  | "dialogue_rewrite"
  | "content_omission"
  | "wrong_attribution"
  | "order_changed"
  | "unsupported_addition"
  | "semantic_drift";

export interface FidelityIssue {
  issueId: string;
  type: FidelityIssueType;
  severity: FidelityIssueSeverity;

  message: string;
  relatedUnitIds?: string[];
  relatedStepIds?: string[];

  suggestion?: string;
}

export interface FidelityReport {
  sceneId: string;
  chapterId: string;

  passed: boolean;
  severity: "pass" | "minor" | "major" | "critical";

  issues: FidelityIssue[];
  patchSuggestions?: string[];

  reviewedAt: string;
}
