/**
 * Saves text as a file through a temporary object URL. The revoke waits a task,
 * because some browsers haven't taken hold of the Blob yet when click() returns.
 */
export function downloadFile(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
