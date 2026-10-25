import { EmailMessage } from "cloudflare:email";
import { contactWorker } from "./contact-mail.js";

/** The contact form Worker (`contact` in vage.config.ts, cloudflare-workers target). See contact-mail.ts. */
export default contactWorker(EmailMessage);
