import { describe, expect, it } from 'vitest'
import { diagnoseRefusal, findOffendingTools, SAFE_MAX_TOKENS, toolNameOf } from '../src/diagnose.ts'
import type { DiagnoseProbe } from '../src/diagnose.ts'

/**
 * A stand-in for maas-api: it refuses the same field-less way, and each test
 * plants one defect that the diagnosis has to find without being told.
 */
function makeGateway(rule: (body: Record<string, unknown>) => boolean): DiagnoseProbe {
  return async body => {
    const rejected = rule(body as Record<string, unknown>)
    return { ok: !rejected, status: rejected ? 400 : 200 }
  }
}

function tool(name: string, valid = true): Record<string, unknown> {
  return {
    ...(valid ? { type: 'function' } : {}),
    function: { name, description: `${name} does something.`, parameters: { type: 'object', properties: {} } },
  }
}

/** A body shaped like the ones that reach maas-api from DSH. */
function agentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'spark-x2.5',
    messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'continue' },
    ],
    max_tokens: 100000,
    stream: true,
    tools: Array.from({ length: 134 }, (_, i) => tool(`tool_${i}`)),
    ...overrides,
  }
}

describe('diagnoseRefusal', () => {
  it('blames the output budget when only a smaller one is accepted', async () => {
    const probe = makeGateway(body => typeof body.max_tokens === 'number' && body.max_tokens > SAFE_MAX_TOKENS)
    const diagnosis = await diagnoseRefusal(agentBody(), probe)

    expect(diagnosis.cause).toBe('max_tokens')
    expect(diagnosis.repair?.max_tokens).toBe(SAFE_MAX_TOKENS)
    expect(await probe(diagnosis.repair as Record<string, unknown>)).toEqual({ ok: true, status: 200 })
  })

  it('names the one broken tool among 134', async () => {
    const broken = tool('dsh_synapse_write', false)
    const tools = Array.from({ length: 133 }, (_, i) => tool(`tool_${i}`))
    tools.splice(97, 0, broken)

    const probe = makeGateway(body =>
      Array.isArray(body.tools) && (body.tools as Array<Record<string, unknown>>).some(entry => entry.type !== 'function'))

    const diagnosis = await diagnoseRefusal(agentBody({ tools }), probe)

    expect(diagnosis.cause).toBe('tools')
    expect(diagnosis.offendingTools).toEqual(['dsh_synapse_write'])
    // Bisection, not a linear scan: 134 entries must cost a handful of probes.
    expect(diagnosis.requests).toBeLessThan(14)
    expect((diagnosis.repair?.tools as unknown[]).length).toBe(133)
    expect(await probe(diagnosis.repair as Record<string, unknown>)).toEqual({ ok: true, status: 200 })
  })

  it('reports a bad message part without pretending to fix it', async () => {
    const messages = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] },
    ]
    const probe = makeGateway(body => JSON.stringify(body.messages).includes('tool_result'))
    const diagnosis = await diagnoseRefusal(agentBody({ messages, max_tokens: 512 }), probe)

    expect(diagnosis.cause).toBe('messages')
    expect(diagnosis.repair).toBeUndefined()
  })

  it('blames the reasoning effort when the model does not offer that level', async () => {
    const probe = makeGateway(body => body.reasoning_effort === 'off')
    const diagnosis = await diagnoseRefusal(agentBody({ max_tokens: 512, reasoning_effort: 'off' }), probe)

    expect(diagnosis.cause).toBe('reasoning_effort')
    expect(diagnosis.repair).not.toHaveProperty('reasoning_effort')
  })

  it('says so when nothing single explains the refusal', async () => {
    const probe = makeGateway(body => body.model === 'spark-x2.5')
    const diagnosis = await diagnoseRefusal(agentBody({ max_tokens: 512 }), probe)

    expect(diagnosis.cause).toBe('unknown')
    expect(diagnosis.repair).toBeUndefined()
    expect(diagnosis.summary).toContain('no single field')
  })

  it('rejects a body that is not an object without probing', async () => {
    let calls = 0
    const diagnosis = await diagnoseRefusal('nope', async () => {
      calls += 1
      return { ok: true, status: 200 }
    })
    expect(diagnosis.cause).toBe('unknown')
    expect(calls).toBe(0)
  })
})

describe('findOffendingTools', () => {
  it('handles a defect in the first entry', async () => {
    const tools = [tool('first', false), tool('second'), tool('third')]
    const probe = makeGateway(body =>
      (body.tools as Array<Record<string, unknown>>).some(entry => entry.type !== 'function'))
    const found = await findOffendingTools({ model: 'm', tools, max_tokens: 512 }, probe)
    expect(found.names).toEqual(['first'])
  })

  it('reports nothing when every definition is accepted', async () => {
    const probe = makeGateway(() => false)
    const found = await findOffendingTools({ model: 'm', tools: [tool('a'), tool('b')], max_tokens: 512 }, probe)
    expect(found.indexes).toEqual([])
  })
})

describe('toolNameOf', () => {
  it('falls back to an index when the entry has no usable name', () => {
    expect(toolNameOf({ type: 'function', function: { name: 'read' } }, 0)).toBe('read')
    expect(toolNameOf({ name: 'legacy' }, 1)).toBe('legacy')
    expect(toolNameOf('nope', 7)).toBe('#7')
  })
})
