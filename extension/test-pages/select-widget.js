// Local pure-JS dropdown widget mimicking the antd Select DOM contract, for exercising the extension's
// selectOption primitive without any external dependency:
//   .ant-select > .ant-select-selector > .ant-select-selection-item        (read target)
//   body > .ant-select-dropdown[.ant-select-dropdown-hidden] > .rc-virtual-list-holder
//        > .rc-virtual-list-holder-inner > .ant-select-item-option > .ant-select-item-option-content
// Clicking an option updates the selection-item text (text mutation is what the content observer watches).
(function () {
  'use strict';

  var STYLE_ID = 'ssba-antd-select-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.ant-select { display: inline-block; min-width: 220px; }',
      '.ant-select-selector { border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 11px; min-height: 32px; cursor: pointer; background: #fff; }',
      '.ant-select-selection-item { line-height: 24px; font-size: 14px; }',
      '.ant-select-dropdown { position: absolute; z-index: 1050; min-width: 220px; margin-top: 4px; background: #fff; border-radius: 6px; box-shadow: 0 6px 16px rgba(0,0,0,.12); padding: 4px 0; }',
      '.ant-select-dropdown.ant-select-dropdown-hidden { display: none; }',
      '.rc-virtual-list-holder { max-height: 264px; overflow-y: auto; }',
      '.ant-select-item-option { padding: 5px 12px; font-size: 14px; cursor: pointer; }',
      '.ant-select-item-option:hover { background: #f5f5f5; }',
      '.ant-select-item-option-content { white-space: nowrap; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  var openDropdown = null;

  function closeDropdown(dropdown) {
    dropdown.classList.add('ant-select-dropdown-hidden');
    if (openDropdown === dropdown) openDropdown = null;
  }

  // container: the .ant-select element; options: array of option texts like "深圳仓 [SZ]"
  window.createAntSelect = function (container, options, initialText) {
    var selector = document.createElement('div');
    selector.className = 'ant-select-selector';
    var selectionItem = document.createElement('span');
    selectionItem.className = 'ant-select-selection-item';
    selectionItem.textContent = initialText || '请选择';
    selector.appendChild(selectionItem);
    container.appendChild(selector);

    var dropdown = document.createElement('div');
    dropdown.className = 'ant-select-dropdown ant-select-dropdown-hidden';
    var holder = document.createElement('div');
    holder.className = 'rc-virtual-list-holder';
    var inner = document.createElement('div');
    inner.className = 'rc-virtual-list-holder-inner';
    holder.appendChild(inner);
    dropdown.appendChild(holder);

    options.forEach(function (text) {
      var option = document.createElement('div');
      option.className = 'ant-select-item-option';
      option.setAttribute('title', text);
      var content = document.createElement('div');
      content.className = 'ant-select-item-option-content';
      content.textContent = text;
      option.appendChild(content);
      option.addEventListener('click', function () {
        selectionItem.textContent = text;
        closeDropdown(dropdown);
        container.dispatchEvent(new Event('change', { bubbles: true }));
      });
      inner.appendChild(option);
    });

    document.body.appendChild(dropdown);

    function place() {
      var rect = container.getBoundingClientRect();
      dropdown.style.left = rect.left + 'px';
      dropdown.style.top = rect.bottom + 'px';
    }

    selector.addEventListener('click', function () {
      if (dropdown.classList.contains('ant-select-dropdown-hidden')) {
        if (openDropdown) closeDropdown(openDropdown);
        place();
        dropdown.classList.remove('ant-select-dropdown-hidden');
        openDropdown = dropdown;
      } else {
        closeDropdown(dropdown);
      }
    });

    document.addEventListener('click', function (event) {
      if (openDropdown === dropdown && !dropdown.contains(event.target) && !container.contains(event.target)) {
        closeDropdown(dropdown);
      }
    });

    return {
      get selectedText() {
        return selectionItem.textContent;
      },
    };
  };
})();
