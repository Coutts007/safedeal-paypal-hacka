// Stand-in for the PayPal JS SDK v6 in the Playwright tests (served in place of the SDK URL). It
// implements the surface PayButton uses. "Approving" just calls onApprove with the order id the
// server created; the fake PayPal API reports that order as APPROVED. Set window.__paypalStub =
// { popupBlocked: true } before the page loads to make popup mode fail as a blocked popup would.
(() => {
  const log = (window.__paypalStubLog = []);
  const opts = () => window.__paypalStub ?? {};

  if (!customElements.get("paypal-button")) {
    customElements.define(
      "paypal-button",
      class extends HTMLElement {
        connectedCallback() {
          this.setAttribute("role", "button");
          this.setAttribute("tabindex", "0");
          this.style.display = "block";
          this.style.padding = "12px";
          this.style.background = "#ffc439";
          this.style.borderRadius = "8px";
          this.style.textAlign = "center";
          this.textContent = "PayPal";
        }
      },
    );
  }

  window.paypal = {
    async createInstance(options) {
      log.push({ step: "createInstance", clientId: options.clientId ?? null });
      return {
        async findEligibleMethods() {
          return { isEligible: (m) => m === "paypal" };
        },
        createPayPalOneTimePaymentSession(callbacks) {
          return {
            async start(startOptions, orderPromise) {
              log.push({ step: "start", presentationMode: startOptions.presentationMode });
              if (opts().popupBlocked && startOptions.presentationMode !== "redirect") {
                const err = new Error("Unable to open the PayPal popup");
                err.code = "ERR_DEV_UNABLE_TO_OPEN_POPUP";
                throw err;
              }
              const { orderId } = await orderPromise;
              log.push({ step: "approve", orderId });
              if (opts().cancel) return callbacks.onCancel?.({ orderId });
              await callbacks.onApprove({ orderId });
            },
            hasReturned: () => false,
            resume: async () => {},
          };
        },
      };
    },
  };
})();
