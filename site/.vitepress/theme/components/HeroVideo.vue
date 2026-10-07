<template>
  <!--
    Decorative landing-hero background. `muted` is required, not cosmetic: every browser blocks
    autoplay for a video with sound, so dropping it would freeze on the first frame. There is no
    `controls` attribute, so no player UI is rendered, and `playsinline` keeps iOS from opening a
    fullscreen player. `aria-hidden` and `tabindex="-1"` keep it out of the accessibility tree.
  -->
  <video
    class="hero-video"
    src="/assets/alisio-winds-720p.webm"
    autoplay
    loop
    muted
    playsinline
    preload="auto"
    disablepictureinpicture
    aria-hidden="true"
    tabindex="-1"
  ></video>
</template>
