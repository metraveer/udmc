export const loaderLabel = loader => ({ fabric: "Fabric", neoforge: "NeoForge" })[loader] || loader;

export function updatePlatformControls(controls, templates, preferred = {}) {
  const loader = preferred.loader ?? controls.loader.value;
  const minecraft = preferred.minecraft ?? controls.minecraft.value;
  const loaders = [...new Set(templates.map(t => t.loader))];
  controls.loader.replaceChildren(...loaders.map(id => new Option(loaderLabel(id), id)));
  if (loaders.includes(loader)) controls.loader.value = loader;
  const matching = templates.filter(t => t.loader === controls.loader.value);
  controls.minecraft.replaceChildren(...[...new Set(matching.map(t => t.minecraft))].map(mc => new Option(mc, mc)));
  if (matching.some(t => t.minecraft === minecraft)) controls.minecraft.value = minecraft;
  const template = matching.find(t => t.minecraft === controls.minecraft.value);
  if (controls.version) controls.version.replaceChildren(...(template ? [new Option(template.loaderVersion, template.loaderVersion)] : []));
  return template;
}
