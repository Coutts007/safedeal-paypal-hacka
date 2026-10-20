// Minimal typings for the PayPal JS SDK v6 surface SafeDeal uses.
// https://developer.paypal.com/sdk/js/reference

export type PayPalApproveData = { orderId: string; payerId?: string };

export type PayPalSdkError = Error & { code?: string };

export type PayPalOneTimePaymentSession = {
  start(
    options: { presentationMode: "auto" | "popup" | "modal" | "redirect" },
    orderPromise: Promise<{ orderId: string }>,
  ): Promise<void>;
  hasReturned?(): boolean;
  resume?(): Promise<void>;
};

export type PayPalSdkInstance = {
  findEligibleMethods(options: { currencyCode: string }): Promise<{
    isEligible(method: string): boolean;
  }>;
  createPayPalOneTimePaymentSession(options: {
    onApprove(data: PayPalApproveData): Promise<void> | void;
    onCancel?(data: unknown): void;
    onError?(error: PayPalSdkError): void;
  }): PayPalOneTimePaymentSession;
};

export type PayPalCreateInstanceOptions = {
  clientId?: string;
  clientToken?: string;
  components: string[];
  pageType?: string;
  clientMetadataId?: string;
};

declare global {
  interface Window {
    paypal?: {
      createInstance(options: PayPalCreateInstanceOptions): Promise<PayPalSdkInstance>;
    };
  }

  namespace React.JSX {
    interface IntrinsicElements {
      "paypal-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        type?: "pay" | "checkout" | "buynow" | "subscribe";
        hidden?: boolean;
      };
    }
  }
}
