// Evaluate capture code in a CDP *isolated world*: same DOM as the page, separate JS globals.
// Needed because real exports can shadow globals (e.g. a React component named `Map` replaces
// window.Map and breaks Playwright's page.evaluate helpers — found while testing a React mockup).
async function isolatedWorld(page) {
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'h2f-capture', grantUniveralAccess: true,
  });
  async function evaluate(expression) {
    const r = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  }
  return {
    cdp,
    /** run a function in the isolated world: iso.eval((a, b) => ..., a, b) — args must be JSON-serialisable */
    eval: (fn, ...args) => evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`),
    /** run a script source (defines globals in the isolated world) */
    run: src => evaluate(src + '\n;true'),
  };
}
module.exports = { isolatedWorld };
