export const scenarios = [
  {
    id: "animated-progress",
    name: "Animated progress reaches the correct timed state",
    category: "animation timing",
    steps: `  - navigate: /scenario/animated-progress
  - wait: 1500
  - visual: { name: timed-progress, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "modal-transition",
    name: "Modal transition finishes centered and unobscured",
    category: "overlay animation",
    steps: `  - navigate: /scenario/modal-transition
  - activate: { role: button, name: Open modal }
  - wait: 350
  - visual: { name: modal-open, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "accordion-height",
    name: "Accordion expansion reveals its complete content",
    category: "height animation",
    steps: `  - navigate: /scenario/accordion-height
  - activate: { role: button, name: Account details }
  - wait: 400
  - visual: { name: accordion-open, target: { css: ".accordion" }, threshold: 0.005 }`
  },
  {
    id: "carousel-slide",
    name: "Carousel advances exactly one complete slide",
    category: "transform animation",
    steps: `  - navigate: /scenario/carousel-slide
  - activate: { role: button, name: Next slide }
  - wait: 500
  - visual: { name: second-slide, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "toast-stack",
    name: "Concurrent toasts stack without overlapping",
    category: "layered animation",
    steps: `  - navigate: /scenario/toast-stack
  - activate: { role: button, name: Add notification }
  - activate: { role: button, name: Add notification }
  - visual: { name: toast-stack, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "skeleton-content",
    name: "Skeleton loader resolves into meaningful content",
    category: "async state",
    steps: `  - clock: { action: install }
  - navigate: /scenario/skeleton-content
  - clock: { action: advance, ms: 900 }
  - expect: { text: "Dashboard ready", timeoutMs: 1200 }
  - screenshot: loaded-dashboard`
  },
  {
    id: "drag-reorder",
    name: "Drag and drop persists the intended list order",
    category: "drag and drop",
    steps: `  - navigate: /scenario/drag-reorder
  - drag: { from: { id: item-a }, to: { id: item-c } }
  - expect: { text: "Order: B,C,A", timeoutMs: 1200 }
  - screenshot: reordered-list`
  },
  {
    id: "responsive-grid",
    name: "Narrow card grid stays within its container",
    category: "responsive layout",
    steps: `  - navigate: /scenario/responsive-grid
  - visual: { name: narrow-grid, target: { css: ".grid" }, threshold: 0.005 }`
  },
  {
    id: "sticky-header",
    name: "Sticky table header remains visible while scrolling",
    category: "scroll positioning",
    steps: `  - navigate: /scenario/sticky-header
  - scroll: { target: { id: scroll-panel }, y: 500 }
  - visual: { name: sticky-scrolled, target: { id: scroll-panel }, threshold: 0.005 }`
  },
  {
    id: "focus-ring",
    name: "Keyboard focus remains visibly discoverable",
    category: "keyboard accessibility",
    steps: `  - navigate: /scenario/focus-ring
  - focus: { role: button, name: "Primary action", exact: true }
  - visual: { name: keyboard-focus, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "dropdown-layer",
    name: "Dropdown menu renders above adjacent content",
    category: "stacking context",
    steps: `  - navigate: /scenario/dropdown-layer
  - activate: { role: button, name: Open actions }
  - visual: { name: dropdown-layer, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "theme-contrast",
    name: "Theme toggle preserves readable foreground contrast",
    category: "theme styling",
    steps: `  - navigate: /scenario/theme-contrast
  - activate: { role: button, name: Use dark theme }
  - visual: { name: dark-theme, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "table-sort",
    name: "Sortable table promotes the highest score first",
    category: "data table",
    steps: `  - navigate: /scenario/table-sort
  - activate: { role: button, name: Sort by score }
  - expect: { text: "First: Ada", timeoutMs: 1200 }
  - screenshot: sorted-table`
  },
  {
    id: "search-filter",
    name: "Search filtering leaves only matching results",
    category: "live filtering",
    steps: `  - navigate: /scenario/search-filter
  - enter: { target: { label: Search }, value: gamma }
  - expect: { target: { css: ".result" }, count: 1, timeoutMs: 1200 }
  - expect: { text: Gamma }
  - screenshot: filtered-results`
  },
  {
    id: "form-validation",
    name: "Invalid form submission exposes an accessible error",
    category: "form validation",
    steps: `  - navigate: /scenario/form-validation
  - enter: { target: { label: Email }, value: not-an-email }
  - activate: { role: button, name: Create account }
  - expect: { target: { role: alert }, text: "Enter a valid email", timeoutMs: 1200 }
  - screenshot: validation-error`
  },
  {
    id: "optimistic-save",
    name: "Optimistic save settles into a confirmed state",
    category: "optimistic UI",
    steps: `  - clock: { action: install }
  - navigate: /scenario/optimistic-save
  - activate: { role: button, name: Save changes }
  - expect: { target: { role: status }, text: Saving }
  - clock: { action: advance, ms: 700 }
  - expect: { target: { role: status }, text: Saved, timeoutMs: 1200 }
  - screenshot: saved-state`
  },
  {
    id: "tabs-panel",
    name: "Tab activation displays the corresponding panel",
    category: "tabs",
    steps: `  - navigate: /scenario/tabs-panel
  - activate: { role: tab, name: Analytics }
  - expect: { target: { role: tabpanel }, text: "Analytics chart", timeoutMs: 1200 }
  - screenshot: analytics-tab`
  },
  {
    id: "virtual-scroll",
    name: "Virtual list renders later items after scrolling",
    category: "virtualization",
    steps: `  - navigate: /scenario/virtual-scroll
  - scroll: { target: { id: virtual-list }, y: 700 }
  - expect: { text: "Item 20", timeoutMs: 1200 }
  - screenshot: virtualized-items`
  },
  {
    id: "chart-animation",
    name: "Animated chart reaches the correct final geometry",
    category: "data visualization animation",
    steps: `  - navigate: /scenario/chart-animation
  - wait: 1700
  - visual: { name: chart-final, target: { css: "#stage" }, threshold: 0.005 }`
  },
  {
    id: "command-palette",
    name: "Keyboard command palette opens the selected destination",
    category: "keyboard interaction",
    steps: `  - navigate: /scenario/command-palette
  - activate: { role: button, name: Open command palette }
  - enter: { target: { label: Command }, value: settings }
  - key: ArrowDown
  - key: Enter
  - expect: { target: { role: status }, text: "Opened Settings", timeoutMs: 1200 }
  - screenshot: command-selected`
  }
];
