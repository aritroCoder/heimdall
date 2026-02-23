export type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface LoggerLike {
  info?: (...args: readonly unknown[]) => void;
  warning?: (...args: readonly unknown[]) => void;
  warn?: (...args: readonly unknown[]) => void;
  error?: (...args: readonly unknown[]) => void;
}

export interface NormalizedLogger {
  info: (...args: readonly unknown[]) => void;
  warning: (...args: readonly unknown[]) => void;
  error: (...args: readonly unknown[]) => void;
}

export interface GithubLabel {
  name?: string | null;
}

export interface GithubUser {
  login?: string | null;
}

export interface GithubPullRequest {
  id?: number;
  number: number;
  author_association?: string | null;
  title?: string | null;
  body?: string | null;
  html_url?: string | null;
  state?: string | null;
  merged_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  base?: {
    ref?: string | null;
  } | null;
  head?: {
    sha?: string | null;
  } | null;
  labels?: GithubLabel[] | null;
  user?: GithubUser | null;
}

export interface GithubPullRequestFile {
  filename: string;
  patch?: string | null;
}

export interface GithubPullRequestCommit {
  commit?: {
    message?: string | null;
  } | null;
}

export interface GithubIssueComment {
  id: number;
  body?: string | null;
}

export interface RepositoryParams {
  owner: string;
  repo: string;
}

export interface PullNumberParams extends RepositoryParams {
  pull_number: number;
}

export interface PullListParams extends RepositoryParams {
  state: string;
  sort?: string;
  direction?: string;
  per_page?: number;
  page?: number;
}

export interface PullListFilesParams extends PullNumberParams {
  per_page?: number;
  page?: number;
}

export interface PullListCommitsParams extends PullNumberParams {
  per_page?: number;
  page?: number;
}

export interface CreateLabelParams extends RepositoryParams {
  name: string;
  color: string;
  description?: string;
}

export interface IssueNumberParams extends RepositoryParams {
  issue_number: number;
}

export interface AddLabelsParams extends IssueNumberParams {
  labels: string[];
}

export interface RemoveLabelParams extends IssueNumberParams {
  name: string;
}

export interface UpdateCommentParams extends RepositoryParams {
  comment_id: number;
  body: string;
}

export interface CreateCommentParams extends IssueNumberParams {
  body: string;
}

export interface DeleteCommentParams extends RepositoryParams {
  comment_id: number;
}

export type PaginatedRoute<TParams extends Record<string, unknown>, TItem> = (
  params: TParams,
) => Promise<{ data: TItem[] }>;

export interface GithubRestPulls {
  get: (params: PullNumberParams) => Promise<{ data: GithubPullRequest }>;
  list: (params: PullListParams) => Promise<{ data: GithubPullRequest[] }>;
  listFiles: (params: PullListFilesParams) => Promise<{ data: GithubPullRequestFile[] }>;
  listCommits: (params: PullListCommitsParams) => Promise<{ data: GithubPullRequestCommit[] }>;
}

export interface GithubRestIssues {
  createLabel: (params: CreateLabelParams) => Promise<unknown>;
  addLabels: (params: AddLabelsParams) => Promise<unknown>;
  removeLabel: (params: RemoveLabelParams) => Promise<unknown>;
  listComments: (params: IssueNumberParams & { per_page?: number; page?: number }) => Promise<{
    data: GithubIssueComment[];
  }>;
  updateComment: (params: UpdateCommentParams) => Promise<unknown>;
  createComment: (params: CreateCommentParams) => Promise<unknown>;
  deleteComment: (params: DeleteCommentParams) => Promise<unknown>;
}

export interface GithubClient {
  rest: {
    pulls: GithubRestPulls;
    issues: GithubRestIssues;
  };
  paginate: <TParams extends Record<string, unknown>, TItem>(
    route: PaginatedRoute<TParams, TItem>,
    params: TParams,
  ) => Promise<TItem[]>;
}

export interface PullRequestEventPayload {
  action: string;
  pull_request?: (GithubPullRequest & { state?: string | null }) | null;
  repository: {
    owner: {
      login: string;
    };
    name: string;
  };
  installation?: {
    id?: number | null;
  } | null;
}

export interface TriageConfig {
  aiSlopThreshold: number;
  lowEffortThreshold: number;
  aiSlopLabel: string;
  lowEffortLabel: string;
  humanReviewedLabel: string;
  trustedAuthors: string[];
  trustedTitlePatterns: string[];
  minFindingsForLabel: number;
  sizeLabels: string[];
  sizeThresholds: number[];
}

export interface TriageConfigInput {
  aiSlopThreshold?: string | number;
  lowEffortThreshold?: string | number;
  aiSlopLabel?: string;
  lowEffortLabel?: string;
  humanReviewedLabel?: string;
  trustedAuthors?: string[];
  trustedTitlePatterns?: string[];
  minFindingsForLabel?: string | number;
  sizeLabels?: string[];
  sizeThresholds?: Array<string | number>;
}

export type TriageCategoryName = 'low-effort' | 'ai-slop';

export interface TriageFinding {
  id: string;
  category: TriageCategoryName;
  points: number;
  detail: string;
}

export interface TriageCategoryResult {
  score: number;
  threshold: number;
  findings: TriageFinding[];
  flagged: boolean;
}

export interface TriageAnalysis {
  bypassed: boolean;
  bypassReason: string | null;
  sizeLabel: string;
  summary: {
    bodyLength: number;
    totalLinesChanged: number;
    fileCount: number;
    hasSource: boolean;
    hasTests: boolean;
    commitCount: number;
    genericCommitRatio: number;
    churnPerFile: number;
  };
  lowEffort: TriageCategoryResult;
  aiSlop: TriageCategoryResult;
}

export interface DuplicateConfig {
  enabled: boolean;
  onlyOnOpened: boolean;
  maxOpenCandidates: number;
  maxMergedCandidates: number;
  maxCandidateComparisons: number;
  mergedLookbackDays: number;
  fileCountDeltaThreshold: number;
  topLevelDirOverlapThreshold: number;
  fileOverlapThreshold: number;
  structuralSimilarityThreshold: number;
  metadataSimilarityThreshold: number;
  candidateFetchConcurrency: number;
  maxPatchCharactersPerFile: number;
  metadataVectorSize: number;
  maxReportedMatches: number;
}

export interface DuplicateConfigInput {
  enabled?: boolean | string | number;
  onlyOnOpened?: boolean | string | number;
  maxOpenCandidates?: number | string;
  maxMergedCandidates?: number | string;
  maxCandidateComparisons?: number | string;
  mergedLookbackDays?: number | string;
  fileCountDeltaThreshold?: number | string;
  topLevelDirOverlapThreshold?: number | string;
  fileOverlapThreshold?: number | string;
  structuralSimilarityThreshold?: number | string;
  metadataSimilarityThreshold?: number | string;
  candidateFetchConcurrency?: number | string;
  maxPatchCharactersPerFile?: number | string;
  metadataVectorSize?: number | string;
  maxReportedMatches?: number | string;
}

export interface PullRequestRepresentation {
  prNumber: number;
  prId: number | null;
  title: string;
  body: string;
  htmlUrl: string;
  baseRef: string;
  state: string;
  mergedAt: string | null;
  fileSet: Set<string>;
  topLevelDirectories: Set<string>;
  fileCount: number;
  changedFunctions: Set<string>;
  changedClasses: Set<string>;
  importsAdded: Set<string>;
  importsRemoved: Set<string>;
  addedTokenFrequency: Map<string, number>;
  removedTokenFrequency: Map<string, number>;
  metadataTokenVector: number[];
  filePathHash: string;
  normalizedDiffHash: string;
  patchFingerprint: string;
  inversePatchFingerprint: string;
}

export type DuplicateReason =
  | 'none'
  | 'patch-id-match'
  | 'normalized-diff-hash-match'
  | 'structural-and-metadata-match'
  | 'inverse-patch-match';

export interface DuplicateSimilarityMetrics {
  fileOverlap: number;
  topLevelDirOverlap: number;
  fileCountDelta: number;
  structuralSimilarity: number;
  metadataSimilarity: number;
  functionOverlap: number;
  classOverlap: number;
  importOverlap: number;
  patchIdMatch: boolean;
  inversePatchMatch: boolean;
  normalizedDiffHashMatch: boolean;
  filePathHashMatch: boolean;
}

export interface DuplicateSimilarity {
  reason: DuplicateReason;
  confidence: number;
  isDuplicate: boolean;
  isRevert: boolean;
  passesCandidateFilter: boolean;
  metrics: DuplicateSimilarityMetrics;
}

export interface DuplicateMatch {
  number: number;
  htmlUrl: string;
  state: string;
  title: string;
  mergedAt: string | null;
  similarity: DuplicateSimilarity;
}

export interface DuplicateThresholds {
  fileOverlap: number;
  structuralSimilarity: number;
  metadataSimilarity: number;
}

export interface DuplicateDetectionResult {
  checked: boolean;
  skipReason: string | null;
  flagged: boolean;
  candidateCount: number;
  comparedCount: number;
  matches: DuplicateMatch[];
  bestMatch: DuplicateMatch | null;
  reverts: DuplicateMatch[];
  thresholds: DuplicateThresholds | null;
}

export interface TriageRunResult {
  skipped: boolean;
  skipReason: string | null;
  analysis: TriageAnalysis | null;
  desiredLabels: string[];
  duplicateDetection: DuplicateDetectionResult;
}

export interface PullRequestContextLike {
  payload: {
    action?: string;
    pull_request?: {
      number: number;
    } | null;
  };
  repo: {
    owner: string;
    repo: string;
  };
}

export interface CoreLike {
  info: (...args: readonly unknown[]) => void;
  warning: (...args: readonly unknown[]) => void;
  error: (...args: readonly unknown[]) => void;
  setOutput: (name: string, value: string) => void;
}
