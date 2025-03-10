import { ChildProcess, fork } from 'child_process';
import path = require('path');

import { PluginConfiguration } from '../../config/nx-json';

// TODO (@AgentEnder): After scoped verbose logging is implemented, re-add verbose logs here.
// import { logger } from '../../utils/logger';

import { RemotePlugin, nxPluginCache } from './internal-api';
import { PluginWorkerResult, consumeMessage, createMessage } from './messaging';

const pool: Set<ChildProcess> = new Set();

const pidMap = new Map<number, { name: string; pending: Set<string> }>();

// transaction id (tx) -> Promise, Resolver, Rejecter
// Makes sure that we can resolve the correct promise when the worker sends back the result
const promiseBank = new Map<
  string,
  {
    promise: Promise<unknown>;
    resolver: (result: any) => void;
    rejecter: (err: any) => void;
  }
>();

export function loadRemoteNxPlugin(plugin: PluginConfiguration, root: string) {
  // this should only really be true when running unit tests within
  // the Nx repo. We still need to start the worker in this case,
  // but its typescript.
  const isWorkerTypescript = path.extname(__filename) === '.ts';
  const workerPath = path.join(__dirname, 'plugin-worker');
  const worker = fork(workerPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      ...(isWorkerTypescript
        ? {
            // Ensures that the worker uses the same tsconfig as the main process
            TS_NODE_PROJECT: path.join(__dirname, '../../../tsconfig.lib.json'),
          }
        : {}),
    },
    execArgv: [
      ...process.execArgv,
      // If the worker is typescript, we need to register ts-node
      ...(isWorkerTypescript ? ['-r', 'ts-node/register'] : []),
    ],
  });
  worker.send(createMessage({ type: 'load', payload: { plugin, root } }));
  pool.add(worker);

  // logger.verbose(`[plugin-worker] started worker: ${worker.pid}`);

  return new Promise<RemotePlugin>((res, rej) => {
    worker.on('message', createWorkerHandler(worker, res, rej));
    worker.on('exit', createWorkerExitHandler(worker));
  });
}

let pluginWorkersShutdown = false;

export async function shutdownPluginWorkers() {
  // Clears the plugin cache so no refs to the workers are held
  nxPluginCache.clear();

  // Marks the workers as shutdown so that we don't report unexpected exits
  pluginWorkersShutdown = true;

  // logger.verbose(`[plugin-pool] starting worker shutdown`);

  const pending = getPendingPromises(pool, pidMap);

  if (pending.length > 0) {
    // logger.verbose(
    //   `[plugin-pool] waiting for ${pending.length} pending operations to complete`
    // );
    await Promise.all(pending);
  }

  // logger.verbose(`[plugin-pool] all pending operations completed`);

  for (const p of pool) {
    p.kill('SIGINT');
  }

  // logger.verbose(`[plugin-pool] all workers killed`);
}

/**
 * Creates a message handler for the given worker.
 * @param worker Instance of plugin-worker
 * @param onload Resolver for RemotePlugin promise
 * @param onloadError Rejecter for RemotePlugin promise
 * @returns Function to handle messages from the worker
 */
function createWorkerHandler(
  worker: ChildProcess,
  onload: (plugin: RemotePlugin) => void,
  onloadError: (err?: unknown) => void
) {
  let pluginName: string;

  return function (message: string) {
    const parsed = JSON.parse(message);
    // logger.verbose(
    //   `[plugin-pool] received message: ${parsed.type} from ${
    //     pluginName ?? worker.pid
    //   }`
    // );
    consumeMessage<PluginWorkerResult>(parsed, {
      'load-result': (result) => {
        if (result.success) {
          const { name, createNodesPattern } = result;
          pluginName = name;
          const pending = new Set<string>();
          pidMap.set(worker.pid, { name, pending });
          onload({
            name,
            createNodes: createNodesPattern
              ? [
                  createNodesPattern,
                  (configFiles, ctx) => {
                    return new Promise(function (res, rej) {
                      const tx =
                        pluginName + ':createNodes:' + performance.now();
                      worker.send(
                        createMessage({
                          type: 'createNodes',
                          payload: { configFiles, context: ctx, tx },
                        })
                      );
                      pending.add(tx);
                      promiseBank.set(tx, {
                        promise: this,
                        resolver: res,
                        rejecter: rej,
                      });
                    });
                  },
                ]
              : undefined,
            createDependencies: result.hasCreateDependencies
              ? (opts, ctx) => {
                  return new Promise(function (res, rej) {
                    const tx = pluginName + ':createNodes:' + performance.now();
                    worker.send(
                      createMessage({
                        type: 'createDependencies',
                        payload: { context: ctx, tx },
                      })
                    );
                    pending.add(tx);
                    promiseBank.set(tx, {
                      promise: this,
                      resolver: res,
                      rejecter: rej,
                    });
                  });
                }
              : undefined,
            processProjectGraph: result.hasProcessProjectGraph
              ? (graph, ctx) => {
                  return new Promise(function (res, rej) {
                    const tx =
                      pluginName + ':processProjectGraph:' + performance.now();
                    worker.send(
                      createMessage({
                        type: 'processProjectGraph',
                        payload: { graph, ctx, tx },
                      })
                    );
                    pending.add(tx);
                    promiseBank.set(tx, {
                      promise: this,
                      resolver: res,
                      rejecter: rej,
                    });
                  });
                }
              : undefined,
          });
        } else if (result.success === false) {
          onloadError(result.error);
        }
      },
      createDependenciesResult: ({ tx, ...result }) => {
        const { resolver, rejecter } = promiseBank.get(tx);
        if (result.success) {
          resolver(result.dependencies);
        } else if (result.success === false) {
          rejecter(result.error);
        }
        pidMap.get(worker.pid)?.pending.delete(tx);
        promiseBank.delete(tx);
      },
      createNodesResult: ({ tx, ...result }) => {
        const { resolver, rejecter } = promiseBank.get(tx);
        if (result.success) {
          resolver(result.result);
        } else if (result.success === false) {
          rejecter(result.error);
        }
        pidMap.get(worker.pid)?.pending.delete(tx);
        promiseBank.delete(tx);
      },
      processProjectGraphResult: ({ tx, ...result }) => {
        const { resolver, rejecter } = promiseBank.get(tx);
        if (result.success) {
          resolver(result.graph);
        } else if (result.success === false) {
          rejecter(result.error);
        }
        pidMap.get(worker.pid)?.pending.delete(tx);
        promiseBank.delete(tx);
      },
    });
  };
}

function createWorkerExitHandler(worker: ChildProcess) {
  return () => {
    if (!pluginWorkersShutdown) {
      pidMap.get(worker.pid)?.pending.forEach((tx) => {
        const { rejecter } = promiseBank.get(tx);
        rejecter(
          new Error(
            `Plugin worker ${
              pidMap.get(worker.pid).name ?? worker.pid
            } exited unexpectedly with code ${worker.exitCode}`
          )
        );
      });
      shutdownPluginWorkers();
    }
  };
}

process.on('exit', () => {
  if (pool.size) {
    shutdownPluginWorkers();
  }
});

function getPendingPromises(
  pool: Set<ChildProcess>,
  pidMap: Map<number, { name: string; pending: Set<string> }>
) {
  const pendingTxs: Array<Promise<unknown>> = [];
  for (const p of pool) {
    const { pending } = pidMap.get(p.pid) ?? { pending: new Set() };
    for (const tx of pending) {
      pendingTxs.push(promiseBank.get(tx)?.promise);
    }
  }
  return pendingTxs;
}
