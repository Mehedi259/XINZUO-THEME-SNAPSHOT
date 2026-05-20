/**
 * Bundle Builder Component
 * A standalone vanilla web component for building custom knife bundles with tiered discounts
 * No external dependencies - works directly in the browser
 */
class BundleBuilderComponent extends HTMLElement {
  /** @type {Set<string>} Set of selected product IDs */
  #selectedProductIds = new Set();

  /** @type {Map<string, {variantId: string, price: number, comparePrice: number, title: string, image: string}>} */
  #productData = new Map();

  /** @type {Array<{minItems: number, discountPercent: number, label: string, discountCode: string}>} */
  #tiers = [];

  #minItems = 3;
  #maxItems = 8;
  #isAddingToCart = false;

  /** @type {string} Currently active series filter handle ('all' = show all) */
  #activeTab = 'all';

  /** @type {Object} Cached DOM references */
  #refs = {};

  connectedCallback() {
    this.#cacheRefs();
    this.#parseConfig();
    this.#parseProductData();
    this.#attachEventListeners();
    this.#updateUI();
    this.#initTabArrows();
  }

  /**
   * Cache all DOM references using ref attributes
   */
  #cacheRefs() {
    const refElements = this.querySelectorAll('[ref]');
    refElements.forEach(el => {
      const refName = el.getAttribute('ref');
      if (refName.endsWith('[]')) {
        const baseName = refName.slice(0, -2);
        if (!this.#refs[baseName]) this.#refs[baseName] = [];
        this.#refs[baseName].push(el);
      } else {
        this.#refs[refName] = el;
      }
    });
  }

  /**
   * Parse configuration from data attributes
   */
  #parseConfig() {
    this.#minItems = parseInt(this.dataset.minItems) || 3;
    this.#maxItems = parseInt(this.dataset.maxItems) || 8;
    try {
      this.#tiers = JSON.parse(this.dataset.tiers || '[]');
      this.#tiers.sort((a, b) => a.minItems - b.minItems);
    } catch {
      this.#tiers = [];
    }
  }

  /**
   * Parse product data from card elements
   */
  #parseProductData() {
    const cards = this.#refs.cards || [];
    for (const card of cards) {
      const productId = card.dataset.productId;
      this.#productData.set(productId, {
        variantId: card.dataset.variantId,
        price: parseInt(card.dataset.price) || 0,
        comparePrice: parseInt(card.dataset.comparePrice) || 0,
        title: card.dataset.title || '',
        image: card.dataset.image || '',
      });
    }
  }

  /**
   * Attach all event listeners
   */
  #attachEventListeners() {
    // Card clicks
    const cards = this.#refs.cards || [];
    cards.forEach(card => {
      card.addEventListener('click', (e) => this.#handleCardClick(e));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.#handleCardClick(e);
        }
      });
    });

    // Tab clicks
    const tabs = this.#refs.tabs || [];
    tabs.forEach(tab => {
      const series = tab.dataset.series;
      tab.addEventListener('click', () => this.#handleTabClick(series));
    });

    // Tab arrows
    if (this.#refs.tabArrowLeft) {
      this.#refs.tabArrowLeft.addEventListener('click', () => this.#handleTabArrow('left'));
    }
    if (this.#refs.tabArrowRight) {
      this.#refs.tabArrowRight.addEventListener('click', () => this.#handleTabArrow('right'));
    }

    // Add to cart button
    if (this.#refs.addToCartBtn) {
      this.#refs.addToCartBtn.addEventListener('click', () => this.#handleAddToCart());
    }

    // Tab scroll indicators
    const container = this.#refs.tabsContainer;
    if (container) {
      container.addEventListener('scroll', () => this.#updateScrollIndicators(), { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => this.#updateScrollIndicators()).observe(container);
      }
    }
  }

  // --- Event Handlers ---

  #handleCardClick(event) {
    const card = event.target.closest('.bundle-card');
    if (!card) return;
    if (card.dataset.available === 'false') return;

    event.preventDefault();
    event.stopPropagation();

    const productId = card.dataset.productId;

    if (this.#selectedProductIds.has(productId)) {
      this.#selectedProductIds.delete(productId);
      card.classList.remove('bundle-card--selected');
      card.setAttribute('aria-pressed', 'false');
    } else {
      if (this.#selectedProductIds.size >= this.#maxItems) {
        this.#shakeButton();
        return;
      }
      this.#selectedProductIds.add(productId);
      card.classList.add('bundle-card--selected');
      card.setAttribute('aria-pressed', 'true');
    }

    // Micro-interaction: brief scale pulse
    card.style.transform = 'scale(0.97)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        card.style.transform = '';
      });
    });

    this.#updateUI();
  }

  async #handleAddToCart() {
    if (this.#isAddingToCart) return;
    if (this.#selectedProductIds.size < this.#minItems) return;

    this.#isAddingToCart = true;
    const btn = this.#refs.addToCartBtn;
    const originalText = btn.textContent;
    
    // Add loading animation
    btn.innerHTML = `
      <span class="bundle-summary__cta-spinner"></span>
      <span>Adding...</span>
    `;
    btn.disabled = true;
    btn.classList.add('bundle-summary__cta--loading');

    try {
      const bundleId = `bundle_${Date.now()}`;
      const bundleCount = this.#selectedProductIds.size;

      let discountPercent = 0;
      let discountCode = '';
      for (const tier of this.#tiers) {
        if (bundleCount >= tier.minItems) {
          discountPercent = tier.discountPercent;
          discountCode = tier.discountCode || '';
        }
      }

      const items = [];
      for (const productId of this.#selectedProductIds) {
        const data = this.#productData.get(productId);
        if (!data) continue;
        items.push({
          id: parseInt(data.variantId),
          quantity: 1,
          properties: {
            '_bundle_id': bundleId,
            '_bundle_count': String(bundleCount),
            '_bundle_source': 'bundle-builder',
            '_bundle_discount_percent': String(discountPercent),
            '_bundle_discount_code': discountCode,
          },
        });
      }

      await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });

      let cart = await fetch('/cart.js').then((r) => r.json());

      // Dispatch custom event for cart drawer
      document.dispatchEvent(new CustomEvent('cart:add', {
        detail: {
          source: 'bundle-builder',
          itemCount: cart.item_count,
        }
      }));

      // Success state
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Added to Cart!</span>
      `;
      btn.classList.remove('bundle-summary__cta--loading');
      btn.classList.add('bundle-summary__cta--success');
      
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('bundle-summary__cta--success');
        btn.disabled = false;
        this.#isAddingToCart = false;
      }, 2500);
    } catch (error) {
      console.error('Bundle add to cart error:', error);
      btn.textContent = 'Error - Try Again';
      btn.classList.remove('bundle-summary__cta--loading');
      btn.classList.add('bundle-summary__cta--error');
      
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('bundle-summary__cta--error');
        btn.disabled = false;
        this.#isAddingToCart = false;
      }, 2000);
    }
  }

  #handleTabClick(seriesHandle) {
    this.#activeTab = seriesHandle;
    this.#updateTabActiveStates();
    this.#filterCards();
    this.#scrollActiveTabIntoView();
  }

  #handleTabArrow(direction) {
    const container = this.#refs.tabsContainer;
    if (!container) return;
    const scrollAmount = container.offsetWidth * 0.65;
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  }

  // --- Tab Management ---

  #initTabArrows() {
    this.#updateScrollIndicators();
  }

  #updateScrollIndicators() {
    const container = this.#refs.tabsContainer;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const canScrollLeft = scrollLeft > 2;
    const canScrollRight = scrollLeft + clientWidth < scrollWidth - 2;

    if (this.#refs.tabFadeLeft) {
      this.#refs.tabFadeLeft.classList.toggle('bundle-tabs__fade--visible', canScrollLeft);
    }
    if (this.#refs.tabFadeRight) {
      this.#refs.tabFadeRight.classList.toggle('bundle-tabs__fade--visible', canScrollRight);
    }
    if (this.#refs.tabArrowLeft) {
      this.#refs.tabArrowLeft.classList.toggle('bundle-tabs__arrow--visible', canScrollLeft);
    }
    if (this.#refs.tabArrowRight) {
      this.#refs.tabArrowRight.classList.toggle('bundle-tabs__arrow--visible', canScrollRight);
    }
  }

  #scrollActiveTabIntoView() {
    const tabs = this.#refs.tabs || [];
    const container = this.#refs.tabsContainer;
    if (!container) return;

    const activeTab = tabs.find((t) => t.dataset.series === this.#activeTab);
    if (!activeTab) return;

    const containerRect = container.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    const padInline = 40;

    if (tabRect.left < containerRect.left + padInline) {
      container.scrollBy({ left: tabRect.left - containerRect.left - padInline, behavior: 'smooth' });
    } else if (tabRect.right > containerRect.right - padInline) {
      container.scrollBy({ left: tabRect.right - containerRect.right + padInline, behavior: 'smooth' });
    }
  }

  #updateTabActiveStates() {
    const tabs = this.#refs.tabs || [];
    for (const tab of tabs) {
      const isActive = tab.dataset.series === this.#activeTab;
      tab.classList.toggle('bundle-tabs__tab--active', isActive);
      tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }

  #filterCards() {
    const cards = this.#refs.cards || [];
    let visibleCount = 0;
    
    for (const card of cards) {
      if (this.#activeTab === 'all') {
        card.style.display = '';
        card.removeAttribute('hidden');
        visibleCount++;
      } else {
        const seriesList = (card.dataset.series || '').split(' ');
        const matches = seriesList.includes(this.#activeTab);
        card.style.display = matches ? '' : 'none';
        if (matches) {
          card.removeAttribute('hidden');
          visibleCount++;
        } else {
          card.setAttribute('hidden', '');
        }
      }
    }
    
    // Show/hide empty state message
    this.#updateEmptyState(visibleCount);
  }

  #updateEmptyState(visibleCount) {
    const grid = this.#refs.grid;
    if (!grid) return;
    
    // Remove existing empty state if any
    const existingEmpty = grid.querySelector('.bundle-builder__empty-state');
    if (existingEmpty) {
      existingEmpty.remove();
    }
    
    // Show empty state if no products visible
    if (visibleCount === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'bundle-builder__empty-state';
      emptyState.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <p>No products available in this series</p>
        <button class="bundle-builder__empty-cta">View All Products</button>
      `;
      
      // Add click handler to "View All" button
      const viewAllBtn = emptyState.querySelector('.bundle-builder__empty-cta');
      if (viewAllBtn) {
        viewAllBtn.addEventListener('click', () => {
          this.#handleTabClick('all');
          // Scroll to top of grid
          grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      
      grid.appendChild(emptyState);
    }
  }

  #updateTabCounts() {
    const tabs = this.#refs.tabs || [];
    for (const tab of tabs) {
      const series = tab.dataset.series;
      const countEl = tab.querySelector('[data-series-count]');
      if (!countEl) continue;

      let count = 0;
      if (series === 'all') {
        count = this.#selectedProductIds.size;
      } else {
        const cards = this.#refs.cards || [];
        for (const card of cards) {
          const seriesList = (card.dataset.series || '').split(' ');
          if (seriesList.includes(series) && this.#selectedProductIds.has(card.dataset.productId)) {
            count++;
          }
        }
      }
      countEl.textContent = count > 0 ? `(${count})` : '';
    }
  }

  // --- UI Updates ---

  #updateUI() {
    const count = this.#selectedProductIds.size;
    const hasSelection = count > 0;

    const summaryBar = this.#refs.summaryBar;
    if (summaryBar) {
      summaryBar.classList.toggle('bundle-summary--visible', hasSelection);
    }

    if (this.#refs.countText) {
      this.#refs.countText.textContent = `${count} of ${this.#maxItems} selected`;
    }

    if (this.#refs.progressText) {
      if (count === 0) {
        this.#refs.progressText.textContent = `Select at least ${this.#minItems} items to unlock your discount`;
        this.#refs.progressText.classList.remove('bundle-builder__progress--complete');
      } else if (count < this.#minItems) {
        const remaining = this.#minItems - count;
        this.#refs.progressText.textContent = `Select ${remaining} more item${remaining > 1 ? 's' : ''} to unlock your discount`;
        this.#refs.progressText.classList.remove('bundle-builder__progress--complete');
      } else {
        this.#refs.progressText.textContent = `${count} item${count > 1 ? 's' : ''} selected — discount applied at checkout!`;
        this.#refs.progressText.classList.add('bundle-builder__progress--complete');
      }
    }

    if (this.#refs.progressFill) {
      const lastTierMin = this.#tiers.length > 0
        ? this.#tiers[this.#tiers.length - 1].minItems
        : this.#maxItems;
      const percent = Math.min((count / lastTierMin) * 100, 100);
      this.#refs.progressFill.style.width = `${percent}%`;

      const fill = this.#refs.progressFill;
      fill.classList.remove('bundle-summary__progress-fill--tier-active', 'bundle-summary__progress-fill--complete');
      if (count >= lastTierMin) {
        fill.classList.add('bundle-summary__progress-fill--complete');
      } else if (this.#tiers.length > 0 && count >= this.#tiers[0].minItems) {
        fill.classList.add('bundle-summary__progress-fill--tier-active');
      }

      const markers = this.#refs.tierMarkers || [];
      for (const marker of markers) {
        const tierMin = parseInt(marker.dataset.tierMin) || 0;
        marker.classList.toggle('bundle-summary__tier-marker--reached', count >= tierMin);
      }
    }

    this.#updateTotals(count);
    this.#updateThumbnails();

    if (this.#refs.addToCartBtn) {
      this.#refs.addToCartBtn.disabled = count < this.#minItems || this.#isAddingToCart;
    }

    this.#updateTabCounts();
  }

  #updateTotals(count) {
    let totalPrice = 0;
    for (const productId of this.#selectedProductIds) {
      const data = this.#productData.get(productId);
      if (data) totalPrice += data.price;
    }

    let activeTier = null;
    let nextTier = null;
    for (let i = 0; i < this.#tiers.length; i++) {
      if (count >= this.#tiers[i].minItems) {
        activeTier = this.#tiers[i];
        nextTier = this.#tiers[i + 1] || null;
      }
    }
    if (!activeTier && this.#tiers.length > 0) {
      nextTier = this.#tiers[0];
    }

    if (activeTier) {
      const savingsAmount = Math.round((totalPrice * activeTier.discountPercent) / 100);
      const discountedPrice = totalPrice - savingsAmount;

      if (this.#refs.originalPrice) {
        this.#refs.originalPrice.textContent = this.#formatMoney(totalPrice);
        this.#refs.originalPrice.hidden = false;
      }
      if (this.#refs.totalPrice) {
        this.#refs.totalPrice.textContent = this.#formatMoney(discountedPrice);
        this.#refs.totalPrice.classList.add('bundle-summary__total-price--discounted');
      }
      if (this.#refs.totalSavings) {
        this.#refs.totalSavings.textContent = `You save ${this.#formatMoney(savingsAmount)}`;
        this.#refs.totalSavings.hidden = false;
      }
    } else {
      if (this.#refs.originalPrice) {
        this.#refs.originalPrice.hidden = true;
      }
      if (this.#refs.totalPrice) {
        this.#refs.totalPrice.textContent = this.#formatMoney(totalPrice);
        this.#refs.totalPrice.classList.remove('bundle-summary__total-price--discounted');
      }
      if (this.#refs.totalSavings) {
        this.#refs.totalSavings.hidden = true;
      }
    }

    if (this.#refs.tierLabel) {
      this.#refs.tierLabel.textContent = activeTier ? activeTier.label : '';
    }

    if (this.#refs.nextTierHint) {
      if (nextTier) {
        const needed = nextTier.minItems - count;
        this.#refs.nextTierHint.textContent = `Add ${needed} more for ${nextTier.label}!`;
      } else if (activeTier) {
        this.#refs.nextTierHint.textContent = 'Maximum discount unlocked!';
      } else {
        this.#refs.nextTierHint.textContent = '';
      }
    }
  }

  #updateThumbnails() {
    const strip = this.#refs.thumbnailStrip;
    if (!strip) return;

    strip.innerHTML = '';
    for (const productId of this.#selectedProductIds) {
      const data = this.#productData.get(productId);
      if (!data || !data.image) continue;

      const img = document.createElement('img');
      img.src = data.image;
      img.alt = data.title;
      img.className = 'bundle-summary__thumb';
      img.width = 40;
      img.height = 40;
      strip.appendChild(img);
    }
  }

  #formatMoney(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  #shakeButton() {
    const btn = this.#refs.addToCartBtn;
    if (!btn) return;
    btn.classList.add('bundle-summary__cta--shake');
    setTimeout(() => btn.classList.remove('bundle-summary__cta--shake'), 500);
  }
}

if (!customElements.get('bundle-builder-component')) {
  customElements.define('bundle-builder-component', BundleBuilderComponent);
}
