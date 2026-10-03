// Preview-only settings for explicitly selected platform uploads.
// Bounds are in the original Three.js world coordinates, like the data baker.
export const uploadPreviewAdaptations = {
  // Keep each authored camp and a modest continuous ground patch; exclude
  // distant landscape and clip props at the focused framing boundary.
  'campfire-campsite/up-1qpf2uec': { focusedBounds: [[-8, -2, -13], [6, 12, 1]], crop: true, architecture: true },
  'campfire-campsite/up-amwgzyv4': { focusedBounds: [[-7, -2, -7], [7, 10, 7]], crop: true, architecture: true },
  'campfire-campsite/up-jalxwef7': { focusedBounds: [[-5, -2, -7], [9, 6, 7]], crop: true, architecture: true },
  'campfire-campsite/up-vmx79e74': { focusedBounds: [[-7, -2, -7], [7, 8, 7]], crop: true, architecture: true },

  // The extraction preview should show the complete vehicle, facing the
  // lower-right direction used by the Gallery card camera.
  'denza-z/up-6pbnnzl6': { rootName: 'DENZA Z Racing', previewYaw: Math.PI, architecture: false },
  'denza-z/up-j3912pm9': { rootName: 'DenzaZ2026RacingTrackEdition', previewYaw: Math.PI / 2, architecture: false },

  // Focus the measured pavilion and courtyard extents; retain a small river
  // edge while cropping the distant water plane and sky/cloud layers.
  'tengwang-pavilion/up-328yey91': { focusedBounds: [[-16, -0.5, -11], [16, 19, 12]], crop: true, architecture: true },
  // Frame the falls, nearby river, and canyon edges; keep authored water
  // geometry while excluding shader particle placeholders.
  'hukou-waterfall/up-ns9oiwlp': { focusedBounds: [[-110, -14, -20], [110, 55, 90]], crop: true, architecture: true },
  // Keep the wall experiment assembly and its impact sphere.
  'q-d9886c5bbd71a318/up-d5mig7uc': { groupIndex: 0, architecture: true },
  // Scene group zero is the submarine; exclude the separate torpedo group.
  'q-c7e65f283bc453a5/up-0aav567i': { groupIndex: 0, previewYaw: Math.PI, architecture: false },
  // Architecture extraction drops the aircraft's shader-only heat quad.
  'q-7520307699d6010e/up-96xjexcb': { groupIndex: 0, previewYaw: -Math.PI / 2, architecture: true },
};
