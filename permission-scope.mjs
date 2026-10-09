// Recognize a complete, literal PowerShell directory-listing command only.
// Descriptions and arbitrary file/path fields do not establish read-only scope.
export function readOnlyScope(command) {
  const match = /^Get-ChildItem\s+-LiteralPath\s+'([A-Za-z]:\\[^'`$;&|<>\r\n]+)'\s+-File\s+(?:-Force\s+)?-ErrorAction\s+Stop\s*\|\s*Select-Object\s+-First\s+([1-9]\d{0,2})\s+-ExpandProperty\s+Name\s*$/i.exec(String(command || ''));
  return match ? { readOnly: true, readPaths: [match[1]], limit: Number(match[2]) } : { readOnly: false, readPaths: [] };
}
