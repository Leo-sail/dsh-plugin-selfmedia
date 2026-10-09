/**
 * Human-approval gate.
 *
 * Every checkpoint in this pipeline is a hard stop: the run pauses and prints
 * the exact decision the user is being asked to make. The gate is deliberately
 * a tool rather than a prose instruction, so the pause is visible in the
 * transcript and the confirmation text is uniform.
 *
 * @module dsh-plugin-selfmedia/tools/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { APPROVAL_POINTS, TOOL_APPROVAL_REQUEST, type ApprovalPoint } from '../contracts.js'

/**
 * Register the approval-request tool.
 *
 * @param ctx - registrant context carrying the tool registry.
 */
export function registerGateTools(ctx: Context): void {
  ctx.tools.register(buildApprovalTool())
}

/**
 * `approval_request` — pause and ask the user to confirm.
 *
 * @returns the tool definition.
 */
function buildApprovalTool() {
  return defineTool({
    name: TOOL_APPROVAL_REQUEST,
    description: `在执行不可逆或需要用户决策的动作前，暂停并请求用户确认。

五个必须请求确认的节点：
- briefing_setup：日报配置首次设定（采集来源、分类、模板、发送时间）
- topic_selected：Top 10 选题确认（用户选定一条后才进入创作链）
- final_draft：文章定稿前最终审查（结构、事实、逻辑都检查完）
- draft_save：公众号草稿保存前（再次确认标题、摘要、封面）
- publish：正式发布前（绝对不与草稿保存合并）

用途：到达任一节点时必须调用，不得跳过，不得自行替用户决定。

限制：本工具只输出确认请求和当前状态摘要，不执行被确认的动作。用户明确回复后才继续。草稿保存与正式发布是两个独立节点，不能合并成一次确认。`,
    parameters: {
      point: {
        type: 'string',
        required: true,
        enum: Object.keys(APPROVAL_POINTS),
        description: '要请求确认的节点。',
      },
      summary: {
        type: 'string',
        required: true,
        description: '当前状态摘要，说明用户正在确认什么。必须包含待确认对象的关键信息，不能只写"请确认"。',
      },
      checklist: {
        type: 'array',
        description: '确认清单，逐项列出需要用户核对的点。draft_save 节点必须提供。',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string', required: true },
          point_label: { type: 'string', required: true },
          awaiting_user: { type: 'boolean', required: true },
          prompt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.prompt }],
    },
    async execute(args) {
      const point = args.point as ApprovalPoint
      const label = APPROVAL_POINTS[point]
      const lines = [
        `⏸ 需要你确认：${label}`,
        '',
        args.summary,
      ]
      if (args.checklist !== undefined && args.checklist.length > 0) {
        lines.push('', '请逐项核对：')
        for (const entry of args.checklist) lines.push(`□ ${entry}`)
      }
      lines.push('', '确认后才能继续。如果你要调整，直接说明要改什么。')
      return {
        point,
        point_label: label,
        awaiting_user: true,
        prompt: lines.join('\n'),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `请求确认 · ${APPROVAL_POINTS[args.point as ApprovalPoint] ?? args.point}`,
      kind: 'other',
    }),
  })
}
