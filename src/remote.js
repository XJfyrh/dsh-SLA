// A small explicit Typert contribution: both faces use identical wire contracts.
const stringCodec = {
  mode: 'strict', typeSymbol: 'string',
  create: () => ({ parse(value) {
    if (typeof value !== 'string') throw new TypeError('Expected a string');
    return value;
  } }),
  jsonSchema: { type: 'string' },
};
const parameter = (name, lookup) => ({
  name, wire: lookup ? 'agentId' : name, source: lookup ? 'lookup' : 'json',
  ...(lookup ? { lookup } : {}), codec: lookup ? { ...stringCodec, typeSymbol: '@deepseek-ai/dsh-session/types#SessionId' } : stringCodec,
});
export const remote = {
  package: 'dsh-sla',
  descriptors: [
    { id: 'dsh-sla:sla/get', namespace: 'sla', service: 'sla', method: 'get', invocation: { kind: 'direct' }, parameters: [parameter('sessionId')], result: stringCodec },
    { id: 'dsh-sla:sla/action', namespace: 'sla', service: 'sla', method: 'action', invocation: { kind: 'direct' }, parameters: [parameter('agent', 'agent'), parameter('input')], result: stringCodec },
  ],
};
