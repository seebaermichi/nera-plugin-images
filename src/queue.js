// Bounded-concurrency task queue with keyed de-duplication (ROADMAP D13).
// No dependency: it is a counter, a waiting list and a promise map.
//
// The same image used on several pages produces the same variant keys, so a
// key that is already queued, running or finished returns the existing
// promise instead of encoding again. The map lives as long as the queue,
// which is one build.

/**
 * @param {{ concurrency?: number }} [options] at least 1
 */
export function createQueue({ concurrency = 1 } = {}) {
    const limit = Math.max(1, Math.floor(concurrency) || 1)
    const waiting = []
    const byKey = new Map()
    let running = 0

    const next = () => {
        while (running < limit && waiting.length > 0) {
            const { task, resolve, reject } = waiting.shift()
            running++
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    running--
                    next()
                })
        }
    }

    return {
        /**
         * Schedule `task` (a function returning a promise). With a `key`, a
         * second call for the same key returns the first call's promise and
         * never runs its own task.
         *
         * @template T
         * @param {() => Promise<T>|T} task
         * @param {string} [key]
         * @returns {Promise<T>}
         */
        add(task, key) {
            if (key !== undefined && byKey.has(key)) return byKey.get(key)

            const promise = new Promise((resolve, reject) => {
                waiting.push({ task, resolve, reject })
            })
            if (key !== undefined) byKey.set(key, promise)
            next()
            return promise
        },

        get running() {
            return running
        },
        get pending() {
            return waiting.length
        },
    }
}
