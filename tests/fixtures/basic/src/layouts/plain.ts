export default function plain({ content, page }: { content: string; page: { title: string } }): string {
  return `<!doctype html><html><head><title>${page.title}</title></head><body data-layout="plain">${content}</body></html>`;
}
