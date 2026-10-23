import { collection, html, raw, type Layout } from "vagejs";
import defaultLayout from "./default.ts";

// Blog index: every page under /blog/, newest first. New posts appear here automatically.
const layout: Layout = (props) => {
  const posts = collection(props.pages, { under: "/blog/", sort: "date" });
  const list = html`<ul>
  ${posts.map((p) => html`<li><a href="${p.route}">${p.title}</a>${p.frontmatter.datePublished ? html` <time datetime="${p.frontmatter.datePublished}">${p.frontmatter.datePublished}</time>` : ""}</li>`)}
</ul>`;
  return defaultLayout({ ...props, content: String(html`${raw(props.content)}${list}`) });
};

export default layout;
