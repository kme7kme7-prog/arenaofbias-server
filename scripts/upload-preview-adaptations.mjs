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
  // Final visually reviewed model adapters from batch A.
  'chinese-architecture/up-981t6jal': { focusedBounds: [[-70, -5, -70], [70, 52, 70]], crop: true },
  'chinese-architecture/up-rxphnhx8': { focusedBounds: [[-130, -8, -280], [130, 105, 275]], crop: true },
  'chinese-architecture/up-gnlm8ut4': { rootName: 'voxel-city' },
  'chinese-architecture/up-ghz2bupq': { focusedBounds: [[-300, -10, -300], [300, 150, 300]], crop: true },
  'chinese-architecture/up-zfbhdxj1': { groupIndex: 0 },
  'chinese-architecture/up-esj2b4ji': { rootName: 'complex', focusedBounds: [[-150, -10, -150], [150, 150, 150]] },
  'chinese-architecture/up-qbcy7oeo': { focusedBounds: [[-180, -5, -180], [190, 80, 190]], crop: true },
  'desk-lamp/up-uvolxrx0': { rootName: 'QILUME' },
  'sydney-opera-house/up-38we2436': { focusedBounds: [[-85, -8, -130], [85, 75, 115]], crop: true },
  'sydney-opera-house/up-7ugeksw2': { rootName: 'sydney-opera-house' },
  'sydney-opera-house/up-b1a1vfmw': { focusedBounds: [[-32, -2, -21], [30, 17, 17]], crop: true },
  'sydney-opera-house/up-2aczl8qo': { groupIndex: 0 },
  'sydney-opera-house/up-z8n8hcbs': { groupIndex: 0 },
  'sydney-opera-house/up-d9060x9a': { rootName: 'opera-house' },
  'sydney-opera-house/up-jl7tw3xn': { groupIndex: 0 },
  'voxel-mountain-city/up-r8wg3b3t': { focusedBounds: [[-250, -10, -220], [250, 200, 220]], crop: true },
  // Final visually reviewed model adapters from batch B.
  'q-d61106403bd11c9c/up-7tirxt7h': { focusedBounds: [[-40, -2, -46], [40, 38, 34]], crop: true },
  'q-d61106403bd11c9c/up-t71vf6jy': { focusedBounds: [[-18, -1, -17], [18, 13, 16]], crop: true },
  'q-d61106403bd11c9c/up-6qhfji89': { focusedBounds: [[-85, -5, -110], [85, 50, 15]], crop: true },
  'q-d61106403bd11c9c/up-9xf3l7fa': { focusedBounds: [[-65, -3, -72], [65, 55, 62]], crop: true },
  'q-27b5a30566b9ba47/up-ni45s1tp': { focusedBounds: [[-140, -5, -140], [140, 75, 140]], crop: true },
  'q-27b5a30566b9ba47/up-zygg29ds': { focusedBounds: [[-125, -3, -125], [125, 65, 125]], crop: true },
  'campfire-campsite/up-oaxt8woi': { focusedBounds: [[-16, -2, -16], [16, 10, 16]], crop: true, architecture: true },
  'campfire-campsite/up-w2xv16kp': { focusedBounds: [[-10, -1, -10], [10, 10, 10]], crop: true, architecture: true },
  'campfire-campsite/up-ko4b7d1m': { focusedBounds: [[-20, -10, -26], [21, 8, 15]], crop: true, architecture: true },
  'campfire-campsite/up-5ca4vvx8': { focusedBounds: [[-16, -2, -16], [16, 8, 16]], crop: true, architecture: true },
  'campfire-campsite/up-fril9n6v': { focusedBounds: [[-16, -3, -16], [16, 10, 16]], crop: true, architecture: true },
  'campfire-campsite/up-rgxg0hn3': { focusedBounds: [[-16, -3, -16], [16, 11, 16]], crop: true, architecture: true },
  'campfire-campsite/up-p0i4ss20': { focusedBounds: [[-18, -3, -18], [18, 15, 18]], crop: true, architecture: true },
  'campfire-campsite/up-31fnrqll': { focusedBounds: [[-16, -3, -16], [16, 13, 16]], crop: true, architecture: true },
  'tengwang-pavilion/up-0wsgja7e': { focusedBounds: [[55, -3, 42], [145, 90, 145]], crop: true, architecture: true },
  'tengwang-pavilion/up-ncu04r37': { focusedBounds: [[-330, -35, 574], [-270, 100, 634]], crop: true, architecture: true },
  'tengwang-pavilion/up-h9wukk8v': { focusedBounds: [[-22, -3, -20], [22, 43, 15]], crop: true, architecture: true },
  'tengwang-pavilion/up-ufhovjnv': { focusedBounds: [[-82, -5, -70], [85, 82, 70]], crop: true, architecture: true },
  'boeing-787/up-538s7083': { groupIndex: 0, architecture: false },
  'boeing-787/up-3r01d1q6': { rootName: 'Boeing 787-9 \u00b7 AERIS', architecture: false },
  // Final visually reviewed model adapters from batch C.
  'miniature-railway-town/up-kbk4sn6r': { focusedBounds: [[-33, -5, -29], [33, 11, 29]], crop: true },
  'miniature-railway-town/up-qvo0g783': { focusedBounds: [[-18, -3, -14], [18, 4, 14]], crop: true },
  'miniature-railway-town/up-4iqarayq': { focusedBounds: [[-25, -6, -18], [25, 10, 18]], crop: true },
  'show1-005/up-rw9v4ioh': { focusedBounds: [[-18, -2, -22], [18, 15, 15]], crop: true },
  'show1-005/up-qarhj4w0': { focusedBounds: [[-72, -5, -70], [72, 55, 118]], crop: true },
  'show1-005/up-x8q6j11x': { focusedBounds: [[-95, -15, -125], [105, 100, 90]], crop: true },
  'show1-005/up-m7jbwqfw': { focusedBounds: [[-72, -12, -74], [74, 75, 72]], crop: true },
  'show1-005/up-r1kaqagf': { focusedBounds: [[-95, -5, -95], [95, 100, 95]], crop: true },
  'show1-005/up-0l2sqif7': { focusedBounds: [[-130, -10, -155], [130, 105, 155]], crop: true },
  'q-f51f3f9cca233da0/up-rc08t81v': { focusedBounds: [[-18, -5, -20], [20, 9, 18]], crop: true },
  'q-f51f3f9cca233da0/up-ha1p7sf7': { focusedBounds: [[-12, -2, -9], [12, 10, 11]], crop: true },
  'q-f51f3f9cca233da0/up-pu1h2ezh': { focusedBounds: [[-11, -4, -12], [12, 10, 10]], crop: true },
  'q-f51f3f9cca233da0/up-b3l7z90n': { focusedBounds: [[-10, -4, -11], [10, 12, 18]], crop: true },
  'voxel-construction-site/up-6cmaei3u': { focusedBounds: [[-160, -10, -120], [160, 60, 115]], crop: true },
  'voxel-construction-site/up-k3hpvjfr': { focusedBounds: [[-40, -4, -40], [40, 36, 40]], crop: true },
  'voxel-construction-site/up-kbv5jbsr': { focusedBounds: [[-35, -4, -31], [35, 38, 33]], crop: true },
  'voxel-construction-site/up-pwaartvt': { focusedBounds: [[-42, -15, -38], [42, 32, 38]], crop: true },
  'q-11ce1cc924bd8f45/up-7nybu68e': { focusedBounds: [[-70, -6, -48], [70, 110, 48]], crop: true },
  'classical-fountain/up-011o3fdd': { focusedBounds: [[-30, -4, -28], [30, 12, 20]], crop: true },
  'q-c7e65f283bc453a5/up-wj8noxq3': { groupIndex: 3 },
  'q-7520307699d6010e/up-8yebftps': { rootName: 'S-17 / \u6c50\u96bc' },
  'q-7520307699d6010e/up-33cqydez': { rootName: '\u865a\u6784\u578b\u53f7 OCEANLINE-07' },
  'q-7520307699d6010e/up-708crnbp': { groupIndex: 1 },
  'rocket-simulation/up-aer19kuz': { focusedBounds: [[-25, -10, -24], [35, 60, 10]], crop: true },
  'rocket-simulation/up-sdlt653i': { focusedBounds: [[-14, -10, -14], [14, 140, 14]], crop: true },
  'q-f51f3f9cca233da0/up-25oqn697': { groupIndex: 0 },
  'q-f51f3f9cca233da0/up-hraahknj': { groupIndex: 8 },
  'q-f51f3f9cca233da0/up-osmk1x6z': { focusedBounds: [[-16, -9, -16], [16, 8, 16]], crop: true },
};
