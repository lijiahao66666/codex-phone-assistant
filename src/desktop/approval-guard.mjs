// Only ordinary command and file approvals with identifiable targets are supported.
// Unknown permission-bearing requests remain unavailable until their UI is verified.
const methods = new Map([
  ['item/commandExecution/requestApproval', 'command'],
  ['item/fileChange/requestApproval', 'file'],
]);

export function inspectApproval(request, threadId) {
  if (!request || !methods.has(request.method) ||
      !(['string', 'number'].includes(typeof request.id)) || request.id === '' ||
      !request.params || request.params.threadId !== threadId ||
      typeof request.params.turnId !== 'string' || !request.params.turnId ||
      typeof request.params.itemId !== 'string' || !request.params.itemId) return null;
  const p = request.params;
  const kind = methods.get(request.method);
  if (kind === 'command' && (p.kind && p.kind !== 'command' ||
      typeof p.command !== 'string' || !p.command.trim() ||
      p.additionalPermissions || p.networkApprovalContext || p.proposedNetworkPolicyAmendments)) return null;
  if (kind === 'file' && p.grantRoot) return null;
  let decisions = ['accept', 'decline'];
  if (kind === 'command' && Array.isArray(p.availableDecisions)) {
    if (!p.availableDecisions.includes('accept')) return null;
    if (p.availableDecisions.includes('decline')) decisions = ['accept', 'decline'];
    else if (p.availableDecisions.includes('cancel')) decisions = ['accept', 'cancel'];
    else return null;
  }
  if (kind === 'command' && p.proposedExecpolicyAmendment != null && (!Array.isArray(p.proposedExecpolicyAmendment) || p.proposedExecpolicyAmendment.some(part => typeof part !== 'string') || !Array.isArray(p.availableDecisions))) return null;
  return { id: request.id, kind, turnId: p.turnId, itemId: p.itemId,
    ...(kind === 'command' ? { command: p.command, cwd: typeof p.cwd === 'string' ? p.cwd : null } : {}),
    reason: typeof p.reason === 'string' ? p.reason : null, decisions };
}

export function matchApproval(state, requestId, kind, decision) {
  if (!state || typeof state.id !== 'string' || !Array.isArray(state.requests) ||
      !['command', 'file'].includes(kind) || !['accept', 'decline', 'cancel'].includes(decision)) return null;
  const matches = state.requests.filter(request => request?.id === requestId);
  if (matches.length !== 1) return null;
  const approval = inspectApproval(matches[0], state.id);
  return approval?.kind === kind && approval.decisions.includes(decision) ? approval : null;
}
