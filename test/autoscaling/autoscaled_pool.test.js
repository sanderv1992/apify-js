import * as _ from '../src/underscore';
import log from '../../build/utils_log';
import { sleep } from '../../build/utils';
import AutoscaledPool from '../../build/autoscaling/autoscaled_pool';

/* eslint-disable no-underscore-dangle */

describe('AutoscaledPool', () => {
    let logLevel;
    beforeAll(() => {
        logLevel = log.getLevel();
        log.setLevel(log.LEVELS.ERROR);
    });

    afterAll(() => {
        log.setLevel(logLevel);
    });

    test('should work with concurrency 1', async () => {
        const range = _.range(0, 10);
        const result = [];

        let isFinished = false;

        const runTaskFunction = () => {
            if (range.length === 1) {
                isFinished = true;
            }

            return new Promise((resolve) => {
                const item = range.shift();
                result.push(item);
                setTimeout(resolve, 5);
            });
        };

        const pool = new AutoscaledPool({
            minConcurrency: 1,
            maxConcurrency: 1,
            runTaskFunction,
            isFinishedFunction: () => Promise.resolve(isFinished),
            isTaskReadyFunction: () => Promise.resolve(!isFinished),
        });
        await pool.run();

        expect(result).toEqual(_.range(0, 10));
    });

    test('should work with concurrency 10', async () => {
        const range = _.range(0, 100);
        const result = [];

        let isFinished = false;

        const runTaskFunction = () => {
            if (range.length === 1) {
                isFinished = true;
            }

            return new Promise((resolve) => {
                const item = range.shift();
                result.push(item);
                setTimeout(resolve, 5);
            });
        };

        const pool = new AutoscaledPool({
            minConcurrency: 10,
            maxConcurrency: 10,
            runTaskFunction,
            isFinishedFunction: () => Promise.resolve(isFinished),
            isTaskReadyFunction: () => Promise.resolve(!isFinished),
        });

        await pool.run();

        expect(result).toEqual(_.range(0, 100));
    });

    test('enables setting concurrency', async () => {
        const range = _.range(0, 100);
        const result = [];

        let isFinished = false;

        const runTaskFunction = () => {
            if (range.length === 1) {
                isFinished = true;
            }

            return new Promise((resolve) => {
                const item = range.shift();
                result.push(item);
                setTimeout(resolve, 5);
            });
        };

        const pool = new AutoscaledPool({
            // Test initial concurrency setting
            minConcurrency: 3,
            maxConcurrency: 13,
            desiredConcurrency: 9,
            runTaskFunction,
            isFinishedFunction: () => Promise.resolve(isFinished),
            isTaskReadyFunction: () => Promise.resolve(!isFinished),
        });

        expect(pool.minConcurrency).toBe(3);
        expect(pool.maxConcurrency).toBe(13);
        expect(pool.desiredConcurrency).toBe(9);

        const promise = await pool.run();

        // Test setting concurrency
        pool.minConcurrency = 4;
        pool.maxConcurrency = 14;
        pool.desiredConcurrency = 7;

        expect(pool.minConcurrency).toBe(4);
        expect(pool.maxConcurrency).toBe(14);
        expect(pool.desiredConcurrency).toBe(7);

        await promise;

        expect(result).toEqual(_.range(0, 100));
    });

    describe('should scale correctly', () => {
        class MockSystemStatus {
            constructor(okNow, okLately) {
                this.okNow = okNow;
                this.okLately = okLately;
                this.getCurrentStatus = () => ({ isSystemIdle: this.okNow });
                this.getHistoricalStatus = () => ({
                    isSystemIdle: this.okLately,
                });
            }
        }

        let pool;
        let systemStatus;
        const cb = () => {};
        beforeEach(() => {
            systemStatus = new MockSystemStatus(true, true);
            pool = new AutoscaledPool({
                minConcurrency: 1,
                maxConcurrency: 100,
                runTaskFunction: async () => {},
                isFinishedFunction: async () => false,
                isTaskReadyFunction: async () => true,
            });
            pool.systemStatus = systemStatus;
        });

        test('works with low values', () => {
            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toBe(2);

            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toBe(2); // because currentConcurrency is not high enough;

            pool._currentConcurrency = 2;
            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toBe(3);

            systemStatus.okNow = false; // this should have no effect
            pool._currentConcurrency = 3;
            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toBe(4);

            systemStatus.okLately = false;
            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toBe(3);
        });

        test('works with high values', () => {
            // Should not scale because current concurrency is too low.
            pool.desiredConcurrency = 50;
            pool._currentConcurrency =
                Math.floor(
                    pool.desiredConcurrency * pool.desiredConcurrencyRatio,
                ) - 1;
            systemStatus.okLately = true;
            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toBe(50);

            // Should scale because we bumped up current concurrency.
            pool._currentConcurrency = Math.floor(
                pool.desiredConcurrency * pool.desiredConcurrencyRatio,
            );
            let newConcurrency =
                pool.desiredConcurrency +
                Math.ceil(pool.desiredConcurrency * pool.scaleUpStepRatio);
            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toEqual(newConcurrency);

            // Should scale down.
            systemStatus.okLately = false;
            newConcurrency =
                pool.desiredConcurrency -
                Math.ceil(pool.desiredConcurrency * pool.scaleDownStepRatio);
            pool._autoscale(cb);
            expect(pool.desiredConcurrency).toEqual(newConcurrency);
        });

        test('works at minConcurrency when currently overloaded', async () => {
            let limit = 5;
            let concurrencyLog = [];
            let count = 0;
            pool.systemStatus.okNow = false;
            pool.runTaskFunction = async () => {
                await sleep(10);
                count++;
            };
            pool.isFinishedFunction = async () => count >= limit;
            pool.isTaskReadyFunction = async () => count < limit;
            pool.desiredConcurrency = 10;
            pool._currentConcurrency = pool.currentConcurrency;

            Object.defineProperty(pool, 'currentConcurrency', {
                get() {
                    return this._currentConcurrency;
                },
                set(v) {
                    concurrencyLog.push(v);
                    this._currentConcurrency = v;
                },
            });

            expect(pool.currentConcurrency).toBe(0);

            await pool.run();
            expect(concurrencyLog.some((n) => n > 1)).toBe(false);

            limit = 50;
            concurrencyLog = [];
            count = 0;
            pool.minConcurrency = 5;

            await pool.run();
            expect(concurrencyLog.some((n) => n > 5)).toBe(false);
        });
    });

    describe('should throw', () => {
        // Turn off unnecessary error logging.
        let originalLevel;
        beforeAll(() => {
            originalLevel = log.getLevel();
            log.setLevel(log.LEVELS.OFF);
        });

        afterAll(() => {
            log.setLevel(originalLevel);
        });

        test('when some of the promises throws', async () => {
            let counter = 0;
            const runTaskFunction = async () => {
                counter++;
                await sleep(1);
                // console.log('AFTER SLEEP');
                if (counter > 20) throw new Error('some-promise-error');
            };

            const pool = new AutoscaledPool({
                maxConcurrency: 5,
                minConcurrency: 5,
                runTaskFunction,
                isFinishedFunction: async () => counter > 200,
                isTaskReadyFunction: async () => true,
            });

            await expect(pool.run()).rejects.toThrow('some-promise-error');
        });

        test('when runTaskFunction throws', async () => {
            const runTaskFunction = async () => {
                await sleep(3);
                throw new Error('some-runtask-error');
            };

            const pool = new AutoscaledPool({
                maxConcurrency: 1,
                runTaskFunction,
                isFinishedFunction: async () => false,
                isTaskReadyFunction: async () => true,
            });

            await expect(pool.run()).rejects.toThrow('some-runtask-error');
        });

        test('when isFinishedFunction throws', async () => {
            let count = 0;
            const pool = new AutoscaledPool({
                maxConcurrency: 1,
                runTaskFunction: async () => {
                    count++;
                },
                isFinishedFunction: async () => {
                    throw new Error('some-finished-error');
                },
                isTaskReadyFunction: async () => {
                    return count < 1;
                },
            });

            await expect(pool.run()).rejects.toThrow('some-finished-error');
        });

        test('when isTaskReadyFunction throws', async () => {
            let count = 0;
            const pool = new AutoscaledPool({
                maxConcurrency: 1,
                runTaskFunction: async () => {
                    count++;
                },
                isFinishedFunction: async () => false,
                isTaskReadyFunction: async () => {
                    if (count > 1) throw new Error('some-ready-error');
                    else return true;
                },
            });

            await expect(pool.run()).rejects.toThrow('some-ready-error');
        });
    });

    test('should not handle tasks added after isFinishedFunction returned true', async () => {
        const isFinished = async () => count > 10;
        let count = 0;

        // Run the pool and close it after 3s.
        const pool = new AutoscaledPool({
            minConcurrency: 3,
            runTaskFunction: async () =>
                sleep(1).then(() => {
                    count++;
                }),
            isFinishedFunction: isFinished,
            isTaskReadyFunction: async () => !(await isFinished()),
        });
        pool.maybeRunIntervalMillis = 5;

        await pool.run();
        await sleep(10);
        expect(count).toBeGreaterThanOrEqual(11);
        // Check finished tasks.
        expect(count).toBeLessThanOrEqual(13);
    });

    test('should break and resume when the task queue is empty for a while', async () => {
        const finished = [];
        let isFinished = false;
        let isTaskReady = true;

        let counter = 0;
        const pool = new AutoscaledPool({
            maxConcurrency: 1,
            runTaskFunction: async () => {
                await sleep(1);
                if (counter === 10) {
                    isTaskReady = false;
                    setTimeout(() => {
                        isTaskReady = true;
                    }, 10);
                }
                if (counter === 19) {
                    isTaskReady = false;
                    isFinished = true;
                }
                counter++;
                finished.push(Date.now());
            },
            isFinishedFunction: async () => isFinished,
            isTaskReadyFunction: async () => !isFinished && isTaskReady,
        });
        pool.maybeRunIntervalMillis = 1;
        await pool.run();

        // Check finished tasks.
        expect(finished).toHaveLength(20);
        expect(finished[11] - finished[10]).toBeGreaterThan(9);
    });

    test('should work with loggingIntervalSecs = null', async () => {
        const pool = new AutoscaledPool({
            minConcurrency: 1,
            maxConcurrency: 100,
            runTaskFunction: () => Promise.resolve(),
            isFinishedFunction: () => Promise.resolve(false),
            isTaskReadyFunction: () => Promise.resolve(true),
            loggingIntervalSecs: null,
        });
        pool._autoscale(() => {});
        expect(pool.desiredConcurrency).toBe(2);
    });

    test('should abort', async () => {
        let finished = false;
        let aborted = false;
        const pool = new AutoscaledPool({
            runTaskFunction: async () => {
                if (!aborted) {
                    await pool.abort();
                    aborted = true;
                } else {
                    return null;
                }
            },
            isFinishedFunction: () => {
                finished = true;
            },
            isTaskReadyFunction: () => !aborted,
        });
        await pool.run();
        expect(finished).toBe(false);
    });

    test('should only finish after tasks complete', async () => {
        let started = false;
        let completed = false;

        const pool = new AutoscaledPool({
            runTaskFunction: async () => {
                started = true;
                await sleep(100);
                completed = true;
            },

            isFinishedFunction: async () => {
                return started;
            },

            isTaskReadyFunction: async () => {
                return !started;
            },
        });

        await pool.run();
        expect(started).toBe(true);
        expect(completed).toBe(true);
    });

    test('should pause and resume', async () => {
        let count = 0;
        const results = [];
        let pauseResolve;
        const pausePromise = new Promise((res) => {
            pauseResolve = res;
        });

        const pool = new AutoscaledPool({
            maybeRunIntervalSecs: 0.01,
            minConcurrency: 10,
            runTaskFunction: async () => {
                results.push(count++);
                if (count === 20) {
                    pool.pause().then(pauseResolve);
                }
            },
            isFinishedFunction: async () => !(count < 50),
            isTaskReadyFunction: async () => count < 50,
        });

        let finished = false;
        const runPromise = pool.run();
        runPromise.then(() => {
            finished = true;
        });
        await pausePromise;
        expect(count).toBe(20);
        expect(finished).toBe(false);
        expect(results).toHaveLength(count);
        results.forEach((r, i) => expect(r).toEqual(i));

        pool.resume();
        await runPromise;
        expect(count).toBe(50);
        expect(finished).toBe(true);
        expect(results).toHaveLength(count);
        results.forEach((r, i) => expect(r).toEqual(i));
    });
});

/* eslint-enable no-underscore-dangle */
