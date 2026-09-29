// Machine-specific locations in capture messages -> constant placeholder.
// A warning such as "request failed: file:///C:/Users/me/AppData/Local/Temp/h2f-helper-x/input/page.html (…)" becomes
// "request failed: <input-dir>/page.html (…)": the warning type, file name and error stay, the folder does not.
const path = require('path'), { pathToFileURL } = require('url');

function inputDirRedactor(file) {
  const dir = path.dirname(path.resolve(file));
  const url = pathToFileURL(dir).href;                       // file:///C:/a%20b/c  (percent-encoded)
  let decoded = url; try { decoded = decodeURI(url); } catch (e) {}
  const forms = [...new Set([url, decoded, url.replace(/^file:\/\/\//, 'file://'), dir, dir.split(path.sep).join('/'), dir.split('/').join('\\')])]
    .sort((a, b) => b.length - a.length);                   // longest first
  return s => {
    let t = String(s);
    for (const f of forms) t = t.split(f + '/').join('<input-dir>/').split(f + '\\').join('<input-dir>/').split(f).join('<input-dir>');
    return t;
  };
}
module.exports = { inputDirRedactor };
