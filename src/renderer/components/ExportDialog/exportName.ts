/**
 * The project's name, as the file's. It used to be the first video clip's
 * name - so an export of "Wedding" came out as "DSC_0042". Premiere names an
 * export after its sequence and Resolve after its timeline; this project has
 * one timeline, and it is called what the project is called. Characters
 * Windows will not take in a file name are dropped.
 */
export function defaultFileName(projectName: string): string {
  const clean = projectName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim();
  return clean || 'export';
}
