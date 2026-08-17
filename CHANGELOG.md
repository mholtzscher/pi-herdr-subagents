# Changelog

## [1.5.0](https://github.com/mholtzscher/pi-herdr-subagents/compare/v1.4.0...v1.5.0) (2026-08-17)


### Features

* **orchestrator:** toggle spawn_pi tool activity with orchestrator mode ([7263938](https://github.com/mholtzscher/pi-herdr-subagents/commit/726393830bd35fa9308ab142a7ae12fcfdd00a97))


### Bug Fixes

* defer spawn_pi tool detection until session start ([c1994c9](https://github.com/mholtzscher/pi-herdr-subagents/commit/c1994c928d803c428c345fd9db4364d4f933f7ad))
* **orchestrator:** bound delegated tasks ([2b55fba](https://github.com/mholtzscher/pi-herdr-subagents/commit/2b55fbaf0df4ef609362fccbe47d4ce63c00dbd3))
* **orchestrator:** bound delegated tasks ([7e53bb1](https://github.com/mholtzscher/pi-herdr-subagents/commit/7e53bb121d25ca2527eee1a6685b301a1a3d1bd7))

## [1.4.0](https://github.com/mholtzscher/pi-herdr-subagents/compare/v1.3.0...v1.4.0) (2026-08-16)


### Features

* **orchestrator:** add cost snapshot command ([e03a6fa](https://github.com/mholtzscher/pi-herdr-subagents/commit/e03a6fa33b3e242e8ffecf47148751ebaf0d8c65))
* **orchestrator:** add cost snapshot command ([1026136](https://github.com/mholtzscher/pi-herdr-subagents/commit/102613655d8ae9ebcc34db732ea7989d4b1a333a))


### Bug Fixes

* discourage child thinking overrides ([231d76a](https://github.com/mholtzscher/pi-herdr-subagents/commit/231d76af80f6b815ed79f6a50588c4f6d2b6913d))
* discourage child thinking overrides ([1f770a5](https://github.com/mholtzscher/pi-herdr-subagents/commit/1f770a55fdc4e47d58e5919fc204800d8cd75197))

## [1.3.0](https://github.com/mholtzscher/pi-herdr-subagents/compare/v1.2.1...v1.3.0) (2026-08-14)

### Features

- add deepseek fallback to worker role ([8381a14](https://github.com/mholtzscher/pi-herdr-subagents/commit/8381a14323483fdd80457afd594d91b1470c0e21))
- add general worker child role ([aa614ee](https://github.com/mholtzscher/pi-herdr-subagents/commit/aa614eeaae059926f0ede3809d908a7974649a77))
- add general worker child role ([b252412](https://github.com/mholtzscher/pi-herdr-subagents/commit/b252412e04af87149f11e5e2452ab23254aa762b))
- **entire:** enable entire checkpointing for pi agent sessions ([d37f8ec](https://github.com/mholtzscher/pi-herdr-subagents/commit/d37f8ecfbdb051b0cfc95384037ec5c67bf96bf2))
- **entire:** enable entire checkpointing for pi agent sessions ([19e6c5b](https://github.com/mholtzscher/pi-herdr-subagents/commit/19e6c5b6cfbfff9720a2be8d6f280a6f01c66bfc))
- load child roles from markdown catalogue ([afd43d8](https://github.com/mholtzscher/pi-herdr-subagents/commit/afd43d8f3e85c46fb849370a6e2ae771d5d86740))
- load child roles from markdown catalogue ([3d69533](https://github.com/mholtzscher/pi-herdr-subagents/commit/3d6953319a5a299f853c332ad4ed204b585e5b15))
- make child placement config-owned ([89447d8](https://github.com/mholtzscher/pi-herdr-subagents/commit/89447d83788ee194102dab36b6b4561171c55a0e))
- make child placement config-owned ([1009ebb](https://github.com/mholtzscher/pi-herdr-subagents/commit/1009ebb1b2430285b78efe32631b5a5ba511c73f))
- **orchestrator:** show roles in status ([10d33ff](https://github.com/mholtzscher/pi-herdr-subagents/commit/10d33ff6e41db5208374071bb0a7a4b4e8cf8eb0))
- **roles:** improve role discovery and visibility ([15443f1](https://github.com/mholtzscher/pi-herdr-subagents/commit/15443f17e68165391705b38e540894abdf4d8078))
- **roles:** support symlinks and clarify selection ([1056a9a](https://github.com/mholtzscher/pi-herdr-subagents/commit/1056a9a3cbae67fb9e679a1b2f3d9f228a6f4373))

### Bug Fixes

- **entire:** preserve parent tracking across subagents ([1fc83bd](https://github.com/mholtzscher/pi-herdr-subagents/commit/1fc83bde78cf98f75b187faf666a7d92ee319541))
- **orchestrator:** preserve role description punctuation ([2f9ab6d](https://github.com/mholtzscher/pi-herdr-subagents/commit/2f9ab6d9500e8f4619282c1bfcb01f4273e7aa9a))

## [1.2.1](https://github.com/mholtzscher/pi-herdr-subagents/compare/v1.2.0...v1.2.1) (2026-08-14)

### Bug Fixes

- **herdr:** wait for a stable foreground shell before starting children ([8c802e9](https://github.com/mholtzscher/pi-herdr-subagents/commit/8c802e907c948d333a23c55b0b4b818c816f7b72))
- **herdr:** wait for a stable foreground shell before starting children ([cf07964](https://github.com/mholtzscher/pi-herdr-subagents/commit/cf07964c86292dd42b4ffde5b0498ebbf6f00402))
- resolve anti-slop lint violations ([f5c6ac3](https://github.com/mholtzscher/pi-herdr-subagents/commit/f5c6ac383f41c5d1b49ece14038b52e41e418146))
- resolve anti-slop lint violations ([617698b](https://github.com/mholtzscher/pi-herdr-subagents/commit/617698b2580d16f055794be023d82da7d43f3d10))
- **spawn:** simplify completed task output ([a81acb8](https://github.com/mholtzscher/pi-herdr-subagents/commit/a81acb8053b2f76872f3becea02f81139c49feb0))
- **spawn:** simplify completed task output ([4c2efcb](https://github.com/mholtzscher/pi-herdr-subagents/commit/4c2efcb18dc42aeb51eeea6e253322d9b8b81964))

## [1.2.0](https://github.com/mholtzscher/pi-herdr-subagents/compare/v1.1.1...v1.2.0) (2026-08-13)

### Features

- add ordered model configuration fallbacks ([cc2243c](https://github.com/mholtzscher/pi-herdr-subagents/commit/cc2243c090efa1ec34ff74f92aa39c617292b284))
- add ordered model configuration fallbacks ([b77cf7f](https://github.com/mholtzscher/pi-herdr-subagents/commit/b77cf7f0dee3a0a12c181ee178fc000c72b7190e))
- add parent orchestrator mode ([6fb1651](https://github.com/mholtzscher/pi-herdr-subagents/commit/6fb1651735d66ad6a1f2090fbbc94d2acb7f17d3))
- add parent orchestrator mode ([d6d0318](https://github.com/mholtzscher/pi-herdr-subagents/commit/d6d0318d0e2b1470192208d33fd35e360eefe6cd))
- **spawn:** unify child task display ([d620783](https://github.com/mholtzscher/pi-herdr-subagents/commit/d620783cb21605b7ddc4651ff9fbc747204bb4aa))
- **spawn:** unify child task display ([494a4af](https://github.com/mholtzscher/pi-herdr-subagents/commit/494a4afe714dd6f919f59d28c631683d6c563912))

### Bug Fixes

- allow disabling unavailable orchestrator ([2eb4be3](https://github.com/mholtzscher/pi-herdr-subagents/commit/2eb4be3f05a322696bdc805224439ad50dda4750))
- **herdr:** clean up readiness abort listeners ([2c3a708](https://github.com/mholtzscher/pi-herdr-subagents/commit/2c3a7088a4928131a9011f95a1ab126c3645d8b4))
- **herdr:** retry child startup until shell is ready ([e6eac3c](https://github.com/mholtzscher/pi-herdr-subagents/commit/e6eac3ca04da1385b42d22d2960fe8592108212b))
- **herdr:** retry child startup until shell is ready ([ae32986](https://github.com/mholtzscher/pi-herdr-subagents/commit/ae32986f3f94d54670b86ba6e3a8203ad0fa7417))
- **herdr:** wait for child shell readiness ([33f89f4](https://github.com/mholtzscher/pi-herdr-subagents/commit/33f89f40fbddac675557381ddb18e48c402dab52))
- **herdr:** wait for child shell readiness ([3cf43d8](https://github.com/mholtzscher/pi-herdr-subagents/commit/3cf43d8db203344b4049e65cf5f8564f2b8613d6))

## [1.1.1](https://github.com/mholtzscher/pi-herdr-subagents/compare/v1.1.0...v1.1.1) (2026-08-13)

### Bug Fixes

- **herdr:** pass role prompts via private temp file to avoid shell arg encoding ([3a44f8a](https://github.com/mholtzscher/pi-herdr-subagents/commit/3a44f8a284ed4d8c01ea24146f3d35aaa196d2c7))

## [1.1.0](https://github.com/mholtzscher/pi-herdr-subagents/compare/v1.0.0...v1.1.0) (2026-08-13)

### Features

- **child-roles:** add child runtime roles ([ab63f98](https://github.com/mholtzscher/pi-herdr-subagents/commit/ab63f980b1eeca660ed17ce493fff813c33506e6))
- **child-roles:** add child runtime roles ([9635958](https://github.com/mholtzscher/pi-herdr-subagents/commit/96359584e7549ea9dd2d46ce59356682e18daaa1))

### Bug Fixes

- **child-roles:** address routing review feedback ([c4dc2fc](https://github.com/mholtzscher/pi-herdr-subagents/commit/c4dc2fcf7ddfd40f1af335748d12d433ff9920e0))

## 1.0.0 (2026-08-12)

### Features

- add visible herdr subagents ([6d2951f](https://github.com/mholtzscher/pi-herdr-subagents/commit/6d2951fdbf3060e24566b5e21cddc9b1a29882d4))
- add visible herdr subagents ([42a7956](https://github.com/mholtzscher/pi-herdr-subagents/commit/42a7956f5b62423cdc47d942523e93b47f8c55b9))
