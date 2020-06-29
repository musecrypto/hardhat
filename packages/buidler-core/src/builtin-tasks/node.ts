import chalk from "chalk";
import debug from "debug";
import { BN, bufferToHex, privateToAddress, toBuffer } from "ethereumjs-util";
import fsExtra from "fs-extra";
import * as path from "path";

import {
  JsonRpcServer,
  JsonRpcServerConfig,
} from "../internal/buidler-evm/jsonrpc/server";
import {
  BUIDLEREVM_NETWORK_NAME,
  SOLC_INPUT_FILENAME,
  SOLC_OUTPUT_FILENAME,
} from "../internal/constants";
import { internalTask, task, types } from "../internal/core/config/config-env";
import { BuidlerError } from "../internal/core/errors";
import { ERRORS } from "../internal/core/errors-list";
import { createProvider } from "../internal/core/providers/construction";
import { lazyObject } from "../internal/util/lazy";
import {
  BuidlerNetworkConfig,
  EthereumProvider,
  ResolvedBuidlerConfig,
} from "../types";

import { TASK_NODE, TASK_NODE_WATCH_COMPILER_OUTPUT } from "./task-names";

const log = debug("buidler:core:tasks:node");

const sleep = (timeout: number) =>
  new Promise((resolve) => setTimeout(resolve, timeout));

function _createBuidlerEVMProvider(
  config: ResolvedBuidlerConfig
): EthereumProvider {
  log("Creating BuidlerEVM Provider");

  const networkName = BUIDLEREVM_NETWORK_NAME;
  const networkConfig = config.networks[networkName] as BuidlerNetworkConfig;

  return lazyObject(() => {
    log(`Creating buidlerevm provider for JSON-RPC sever`);
    return createProvider(
      networkName,
      { loggingEnabled: true, ...networkConfig },
      config.solc.version,
      config.paths
    );
  });
}

function logBuidlerEvmAccounts(networkConfig: BuidlerNetworkConfig) {
  if (networkConfig.accounts === undefined) {
    return;
  }

  console.log("Accounts");
  console.log("========");

  for (const [index, account] of networkConfig.accounts.entries()) {
    const address = bufferToHex(privateToAddress(toBuffer(account.privateKey)));
    const privateKey = bufferToHex(toBuffer(account.privateKey));
    const balance = new BN(account.balance)
      .div(new BN(10).pow(new BN(18)))
      .toString(10);

    console.log(`Account #${index}: ${address} (${balance} ETH)
Private Key: ${privateKey}
`);
  }
}

export default function () {
  internalTask(TASK_NODE_WATCH_COMPILER_OUTPUT)
    .addParam("url", "The URL of the node", undefined, types.string)
    .setAction(async ({ url }: { url: string }, { config }) => {
      const { default: fetch } = await import("node-fetch");
      const chokidar = await import("chokidar");

      const compilerVersion = config.solc.version;
      const solcInputPath = path.join(config.paths.cache, SOLC_INPUT_FILENAME);
      const solcOutputPath = path.join(
        config.paths.cache,
        SOLC_OUTPUT_FILENAME
      );

      const addCompilationResult = async () => {
        if (
          !(await fsExtra.pathExists(
            path.join(config.paths.cache, SOLC_INPUT_FILENAME)
          ))
        ) {
          return false;
        }

        if (
          !(await fsExtra.pathExists(
            path.join(config.paths.cache, SOLC_OUTPUT_FILENAME)
          ))
        ) {
          return false;
        }

        const compilerInput = await fsExtra.readJSON(solcInputPath, {
          encoding: "utf8",
        });
        const compilerOutput = await fsExtra.readJSON(solcOutputPath, {
          encoding: "utf8",
        });

        await fetch(url, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "buidler_addCompilationResult",
            params: [compilerVersion, compilerInput, compilerOutput],
            id: 1,
          }),
        });
      };

      chokidar
        .watch(solcOutputPath, {
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 250,
            pollInterval: 50,
          },
        })
        .on("add", addCompilationResult)
        .on("change", addCompilationResult);
    });

  task(TASK_NODE, "Starts a JSON-RPC server on top of Buidler EVM")
    .addOptionalParam(
      "hostname",
      "The host to which to bind to for new connections",
      "localhost",
      types.string
    )
    .addOptionalParam(
      "port",
      "The port on which to listen for new connections",
      8545,
      types.int
    )
    .setAction(
      async (
        { hostname, port },
        { network, buidlerArguments, config, run }
      ) => {
        if (
          network.name !== BUIDLEREVM_NETWORK_NAME &&
          // We normally set the default network as buidlerArguments.network,
          // so this check isn't enough, and we add the next one. This has the
          // effect of `--network <defaultNetwork>` being a false negative, but
          // not a big deal.
          buidlerArguments.network !== undefined &&
          buidlerArguments.network !== config.defaultNetwork
        ) {
          throw new BuidlerError(
            ERRORS.BUILTIN_TASKS.JSONRPC_UNSUPPORTED_NETWORK
          );
        }

        try {
          const serverConfig: JsonRpcServerConfig = {
            hostname,
            port,
            provider: _createBuidlerEVMProvider(config),
          };

          const server = new JsonRpcServer(serverConfig);

          const { port: actualPort, address } = await server.listen();

          console.log(
            chalk.green(
              `Started HTTP and WebSocket JSON-RPC server at http://${address}:${actualPort}/`
            )
          );

          console.log();

          try {
            await run(TASK_NODE_WATCH_COMPILER_OUTPUT, {
              url: `http://${address}:${actualPort}/`,
            });
          } catch (error) {
            console.warn(
              chalk.yellow(
                "There was a problem watching the compiler output, changes in the contracts won't be reflected in the Buidler EVM. Run Buidler with --verbose to learn more."
              )
            );

            log(
              "Compilation output can't be watched. Please report this to help us improve Buidler.\n",
              error
            );
          }

          const networkConfig = config.networks[
            BUIDLEREVM_NETWORK_NAME
          ] as BuidlerNetworkConfig;
          logBuidlerEvmAccounts(networkConfig);

          await server.waitUntilClosed();
        } catch (error) {
          if (BuidlerError.isBuidlerError(error)) {
            throw error;
          }

          throw new BuidlerError(
            ERRORS.BUILTIN_TASKS.JSONRPC_SERVER_ERROR,
            {
              error: error.message,
            },
            error
          );
        }
      }
    );
}
