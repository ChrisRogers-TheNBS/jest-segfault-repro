'use strict';

/**
 * SegfaultBailReporter
 *
 * Forces the Jest process to exit immediately when a worker crashes with a
 * signal (e.g. SIGSEGV, SIGBUS).  By default, Jest continues running
 * remaining test suites even after a worker dies, which makes automated
 * reproduction loops very slow when the goal is just to confirm a crash
 * happened.
 *
 * Usage – add to jest.config.js:
 *   reporters: ['default', './segfault-bail-reporter.js']
 */
class SegfaultBailReporter {
  /**
   * Called by Jest in the main process after each test file finishes
   * (or fails to finish because the worker died).
   *
   * When a worker is killed by a signal, Jest surfaces the error through
   * testResult.testExecError.  The message typically contains the signal
   * name (SIGSEGV, SIGBUS, …) or a generic "worker quit unexpectedly"
   * phrase.  Either way we treat it as a fatal crash and bail.
   */
  onTestFileResult(_test, testResult) {
    const execError = testResult.testExecError;
    if (!execError) return;

    const text = [execError.message, execError.stack, execError.type]
      .filter(Boolean)
      .join('\n');

    const isCrash =
      // Explicit signal names
      /SIGSEGV|SIGBUS|SIGABRT|SIGILL|SIGFPE/i.test(text) ||
      // jest-worker generic "worker quit unexpectedly" message
      /worker.*quit\s+unexpectedly|quit\s+unexpectedly.*worker/i.test(text) ||
      // jest-worker "exited with signal"
      /exited\s+with\s+signal/i.test(text);

    if (isCrash) {
      // Print to stderr so the message appears regardless of --silent.
      process.stderr.write(
        `\n[SegfaultBailReporter] Worker crash detected in ${testResult.testFilePath}` +
          `\n  ${execError.message}\n` +
          `Forcing exit.\n\n`
      );
      process.exit(1);
    }
  }
}

module.exports = SegfaultBailReporter;
