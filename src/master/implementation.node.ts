// tslint:disable no-eval max-classes-per-file

import getCallsites, { CallSite } from "callsites"
import EventEmitter from "events"
import { cpus } from 'os'
import * as path from "path"
import { WorkerImplementation } from "../types/master"

declare const __non_webpack_require__: typeof require

type WorkerEventName = "error" | "message"

const defaultPoolSize = cpus().length

function rebaseScriptPath(scriptPath: string, ignoreRegex: RegExp) {
  const parentCallSite = getCallsites().find((callsite: CallSite) => {
    const filename = callsite.getFileName()
    return Boolean(filename && !filename.match(ignoreRegex) && !filename.match(/[\/\\]master[\/\\]implementation/))
  })

  const callerPath = parentCallSite ? parentCallSite.getFileName() : null
  const rebasedScriptPath = callerPath ? path.join(path.dirname(callerPath), scriptPath) : scriptPath

  return rebasedScriptPath.replace(/\.ts$/, ".js")
}

function resolveScriptPath(scriptPath: string) {
  // eval() hack is also webpack-related
  const workerFilePath = typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__.resolve(path.join(eval("__dirname"), scriptPath))
    : require.resolve(rebaseScriptPath(scriptPath, /[\/\\]worker_threads[\/\\]/))

  return workerFilePath
}

function initWorkerThreadsWorker(): typeof WorkerImplementation {
  // Webpack hack
  const NativeWorker = typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__("worker_threads").Worker
    : eval("require")("worker_threads").Worker

  class Worker extends NativeWorker {
    private mappedEventListeners: WeakMap<EventListener, EventListener>

    constructor(scriptPath: string) {
      super(resolveScriptPath(scriptPath), [], { esm: true })
      this.mappedEventListeners = new WeakMap()
    }

    public addEventListener(eventName: string, rawListener: EventListener) {
      const listener = (message: any) => {
        rawListener({ data: message } as any)
      }
      this.mappedEventListeners.set(rawListener, listener)
      this.on(eventName, listener)
    }

    public removeEventListener(eventName: string, rawListener: EventListener) {
      const listener = this.mappedEventListeners.get(rawListener) || rawListener
      this.off(eventName, listener)
    }
  }
  return Worker as any
}

function initTinyWorker(): typeof WorkerImplementation {
  const TinyWorker = require("tiny-worker")

  let allWorkers: Array<typeof TinyWorker> = []

  class Worker extends TinyWorker {
    private emitter: EventEmitter

    constructor(scriptPath: string) {
      // Need to apply a work-around for Windows or it will choke upon the absolute path
      // (`Error [ERR_INVALID_PROTOCOL]: Protocol 'c:' not supported`)
      const resolvedScriptPath = process.platform === "win32"
        ? path.relative(process.cwd(), resolveScriptPath(scriptPath))
        : resolveScriptPath(scriptPath)

      super(resolvedScriptPath, [], { esm: true })
      allWorkers.push(this)

      this.emitter = new EventEmitter()
      this.onerror = (error: Error) => this.emitter.emit("error", error)
      this.onmessage = (message: MessageEvent) => this.emitter.emit("message", message)
    }
    public addEventListener(eventName: WorkerEventName, listener: EventListener) {
      this.emitter.addListener(eventName, listener)
    }
    public removeEventListener(eventName: WorkerEventName, listener: EventListener) {
      this.emitter.removeListener(eventName, listener)
    }
    public terminate() {
      allWorkers = allWorkers.filter(worker => worker !== this)
      return super.terminate()
    }
  }

  const terminateAll = () => {
    allWorkers.forEach(worker => worker.terminate())
    allWorkers = []
  }

  // Take care to not leave orphaned processes behind
  // See <https://github.com/avoidwork/tiny-worker#faq>
  process.on("SIGINT", () => terminateAll())
  process.on("SIGTERM", () => terminateAll())

  return Worker as any
}

function selectWorkerImplementation(): typeof WorkerImplementation {
  try {
    return initWorkerThreadsWorker()
  } catch(error) {
    // tslint:disable-next-line no-console
    console.debug("Node worker_threads not available. Trying to fall back to tiny-worker polyfill...")
    return initTinyWorker()
  }
}

export default {
  defaultPoolSize,
  selectWorkerImplementation
}
