/** Add the shared Agent Skills catalog to the model's prompt. */

import { defineExtension, section } from "@earendil-works/pi-durable";
import { renderSkillsPrompt } from "../skills.ts";

export default defineExtension({
  name: "skills",
  sections: [section("skills", renderSkillsPrompt)],
});
