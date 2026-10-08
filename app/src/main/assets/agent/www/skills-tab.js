// Skills settings tab: a read-only view of the shared Agent Skills directory.
const skillsList = document.getElementById("skills-list");
const skillsLocation = document.getElementById("skills-location");
const refreshSkillsBtn = document.getElementById("refresh-skills-btn");

function escapeSkillHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderSkills(data) {
  if (skillsLocation) {
    // The label must stay on one line on a phone; the full path goes in a tooltip because the
    // visible path is truncated.
    skillsLocation.innerHTML = `${iconTag("folder", 14, "dim")} <span class="skills-location-label">Shared skills folder</span> <code title="${escapeSkillHtml(data.directory)}">${escapeSkillHtml(data.directory)}</code>`;
  }

  const skills = Array.isArray(data.skills) ? data.skills : [];
  if (!skillsList) return;
  if (!skills.length) {
    skillsList.innerHTML = `
      <div class="skills-empty">
        ${iconTag("sparkles", 20, "dim")}
        <strong>No skills found</strong>
        <p class="description">Add one folder per skill, with a <code>SKILL.md</code> file inside. Skills are shared across sessions; new or edited skills appear after Refresh and are included in the next model request.</p>
        <code class="skills-example-path">${escapeSkillHtml(data.directory)}/my-skill/SKILL.md</code>
      </div>`;
    return;
  }

  skillsList.innerHTML = skills.map((skill) => `
    <article class="skill-card">
      <div class="skill-card-head">
        ${iconTag("sparkles", 16, "dim")}
        <strong>${escapeSkillHtml(skill.name)}</strong>
      </div>
      <p>${escapeSkillHtml(skill.description)}</p>
      <div class="skill-card-path">${iconTag("file-text", 13, "dim")}<code>${escapeSkillHtml(skill.location)}</code></div>
    </article>`).join("");
}

async function loadSkills() {
  if (!skillsList) return;
  if (!skillsList.dataset.loaded) skillsList.innerHTML = '<p class="description">Loading skills…</p>';
  if (refreshSkillsBtn) refreshSkillsBtn.disabled = true;
  try {
    const response = await fetch("/api/skills");
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || response.statusText);
    renderSkills(data);
    skillsList.dataset.loaded = "1";
  } catch (error) {
    skillsList.innerHTML = `<p class="description">Could not load skills: ${escapeSkillHtml(error instanceof Error ? error.message : error)}</p>`;
  } finally {
    if (refreshSkillsBtn) refreshSkillsBtn.disabled = false;
  }
}

refreshSkillsBtn?.addEventListener("click", loadSkills);
window.loadSkillsTab = loadSkills;
