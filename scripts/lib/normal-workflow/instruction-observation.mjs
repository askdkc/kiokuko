/** Actual protocol responses and a client loader receipt are all required. */
export function observeInstructions({ messages, events, indexes, agentsHash, observations, kind }) {
  const requests = messages.filter(item => item.direction === 'request' && item.message.method === 'tools/call').map(item => item.message);
  const successful = name => requests.filter(call => {
    const result = messages.find(item => item.direction === 'response' && item.message.id === call.id)?.message.result;
    return call.params.name === name && result && result.isError !== true;
  });
  const discovered = messages.some(item => item.direction === 'response' && Array.isArray(item.message.result?.tools));
  const reads = successful('task_inspect').filter(call => call.params.arguments.operation === 'skill');
  const registrations = successful(kind === 'conversation' ? 'memory_recall' : 'task_prepare')
    .filter(call => call.params.arguments.soulRead === true);
  const loadedSkills = reads.length >= 2 && registrations.some(call => indexes.every(index =>
    call.params.arguments.capabilities?.some(capability => capability.kind === 'skill' && capability.name === index.name)));
  const agentsLoadObserved = events.some(event => event.type === 'instructions.loaded' && event.content_hash === agentsHash);
  return { discovered, loadedSkills, agentsLoadObserved,
    instructionsVerified: discovered && loadedSkills && agentsLoadObserved
      && (kind === 'conversation' ? successful('task_prepare').length === 0
        : observations.some(item => item.event_name === 'UserPromptSubmit' && item.decision === 'handled')) };
}
