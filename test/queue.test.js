import { describe, it, expect } from 'vitest'
import { createQueue } from '../src/queue.js'

// A task whose completion the test controls.
function deferred() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('createQueue', () => {
    it('runs no more than `concurrency` tasks at once', async () => {
        const queue = createQueue({ concurrency: 2 })
        const gates = [deferred(), deferred(), deferred(), deferred()]
        let active = 0
        let peak = 0

        const results = gates.map((gate, i) =>
            queue.add(async () => {
                active++
                peak = Math.max(peak, active)
                await gate.promise
                active--
                return i
            })
        )
        await tick()
        expect(queue.running).toBe(2)
        expect(queue.pending).toBe(2)

        gates.forEach((gate) => gate.resolve())
        expect(await Promise.all(results)).toEqual([0, 1, 2, 3])
        expect(peak).toBe(2)
        expect(queue.running).toBe(0)
    })

    it('starts tasks in the order they were added', async () => {
        const queue = createQueue({ concurrency: 1 })
        const order = []

        await Promise.all([1, 2, 3].map((n) => queue.add(() => order.push(n))))

        expect(order).toEqual([1, 2, 3])
    })

    it('runs a keyed task once and shares its promise', async () => {
        const queue = createQueue({ concurrency: 4 })
        let calls = 0
        const task = async () => {
            calls++
            return 'done'
        }

        const first = queue.add(task, 'a.avif')
        const second = queue.add(task, 'a.avif')

        expect(second).toBe(first)
        expect(await Promise.all([first, second])).toEqual(['done', 'done'])
        // Still deduplicated after it settled: one build, one encode.
        expect(await queue.add(task, 'a.avif')).toBe('done')
        expect(calls).toBe(1)

        await queue.add(task, 'b.avif')
        await queue.add(task)
        await queue.add(task)
        expect(calls).toBe(4)
    })

    it('rejects a failing task and keeps running the rest', async () => {
        const queue = createQueue({ concurrency: 1 })

        const failing = queue.add(() => {
            throw new Error('boom')
        })
        const ok = queue.add(async () => 'ok')

        await expect(failing).rejects.toThrow('boom')
        expect(await ok).toBe('ok')
    })

    it('treats a missing or invalid concurrency as 1', async () => {
        for (const queue of [createQueue(), createQueue({ concurrency: 0 }), createQueue({ concurrency: NaN })]) {
            const gate = deferred()
            queue.add(() => gate.promise)
            queue.add(() => {})
            await tick()
            expect(queue.running).toBe(1)
            gate.resolve()
        }
    })
})
