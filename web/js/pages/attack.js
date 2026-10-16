// Attack panel page: built in Milestone 8.1. Hidden in the sidebar until Beacon reports it is enabled.
export default {
  title: 'Attack Panel',
  subtitle: 'Fire the hostile cases against the live system and see the verdict.',
  mount(root) { root.innerHTML = '<section class="card"><div class="empty"><h3>Attack panel is not enabled</h3><p>Set ENABLE_ATTACK_PANEL=true on the Beacon server.</p></div></section>'; },
};
