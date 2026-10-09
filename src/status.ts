/**
 * Content and comment status vocabulary.
 *
 * Every collected item carries BOTH a content status and a comment status, and
 * neither may be left blank. The distinction matters because the pipeline forbids
 * inferring comment opinion from article body text: when a comment status is
 * anything other than `available` / `partial`, the analyst agent must not write
 * "users are concerned about X" — it may only report body-derived observations,
 * labelled as such.
 *
 * @module dsh-plugin-selfmedia/status
 */

/** Whether an article body was obtained. */
export const CONTENT_STATUSES = [
  'complete',
  'partial',
  'not_available',
  'permission_denied',
  'not_found',
] as const

export type ContentStatus = (typeof CONTENT_STATUSES)[number]

/** Whether comments were obtained. */
export const COMMENT_STATUSES = [
  'available',
  'partial',
  'not_available',
  'permission_denied',
  'not_collected',
] as const

export type CommentStatus = (typeof COMMENT_STATUSES)[number]

/** Where a "user focus" line came from. Never guess this. */
export const FOCUS_SOURCES = ['正文推断', '评论提取', '综合'] as const

export type FocusSource = (typeof FOCUS_SOURCES)[number]

/** Fact-check status for one claim in the evidence ledger. */
export const CLAIM_STATUSES = [
  'confirmed',
  'partially_confirmed',
  'inferred',
  'disputed',
  'unverified',
] as const

export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/**
 * Whether comments can be analysed at all.
 *
 * `comment-analysis` refuses to run unless this returns true — the guard exists
 * so a caller cannot silently produce comment themes for an article whose
 * comments were never fetched.
 *
 * @param status - the item's comment status.
 * @returns whether comment text is present and analysable.
 */
export function isCommentAnalysable(status: CommentStatus): boolean {
  return status === 'available' || status === 'partial'
}

/**
 * Build the status pair for one collected item, refusing a blank reason.
 *
 * @param content - the body's status.
 * @param comment - the comment thread's status.
 * @param reason - why the statuses are what they are; must be non-empty.
 * @returns the immutable status record.
 */
export function makeStatusPair(
  content: ContentStatus,
  comment: CommentStatus,
  reason: string,
): { content_status: ContentStatus; comment_status: CommentStatus; status_reason: string } {
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    throw new Error('a status pair requires a non-empty status_reason')
  }
  return { content_status: content, comment_status: comment, status_reason: trimmed }
}
