// The Cloudflare Workers runtime module the contact Worker sends mail with.
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
  }
}
