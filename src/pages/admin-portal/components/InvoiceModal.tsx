import { useEffect } from 'react';

interface InvoiceItem {
  description: string;
  sac: string;
  qty: number;
  rate: number;
  taxable: number;
  cgst: number;
  sgst: number;
  amount: number;
}

export interface InvoiceData {
  id: string;
  type: 'invoice' | 'receipt';
  date: string;
  dueDate?: string;
  seller: {
    name: string;
    address: string[];
    gstin: string;
    pan: string;
    email: string;
    phone: string;
    cin?: string;
  };
  buyer: {
    name: string;
    address: string[];
    gstin: string;
    stateCode: string;
  };
  items: InvoiceItem[];
  taxableTotal: number;
  totalCgst: number;
  totalSgst: number;
  grandTotal: number;
  amountWords: string;
  paidDate?: string;
  paymentMethod?: string;
  transactionId?: string;
}

interface Props {
  data: InvoiceData;
  onClose: () => void;
}

export default function InvoiceModal({ data, onClose }: Props) {
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const handlePrint = () => window.print();

  const isReceipt = data.type === 'receipt';

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 no-print">
      <div className="bg-white rounded-xl w-full max-w-[800px] max-h-[92vh] overflow-y-auto shadow-2xl">

        {/* Screen Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between rounded-t-xl z-10">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 flex items-center justify-center bg-emerald-50 rounded-lg">
              <i className="ri-bill-line text-emerald-600" />
            </span>
            <div>
              <h2 className="text-sm font-bold text-gray-900">
                {isReceipt ? 'Payment Receipt' : 'Tax Invoice'}
              </h2>
              <p className="text-[11px] text-gray-500">{data.id} · {data.date}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-600 text-xs font-medium border border-emerald-200 hover:bg-emerald-100 transition-colors flex items-center gap-1.5"
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center">
                <i className="ri-printer-line text-xs" />
              </span>
              Print / Save PDF
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
            >
              <i className="ri-close-line text-sm" />
            </button>
          </div>
        </div>

        {/* Print-only header */}
        <div className="print-only p-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-black text-gray-900 tracking-tight">
                {isReceipt ? 'RECEIPT' : 'TAX INVOICE'}
              </h1>
              <p className="text-sm text-gray-600 mt-1 font-medium">{data.seller.name}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold text-gray-900">{data.id}</p>
              <p className="text-xs text-gray-600">Date: {data.date}</p>
              {!isReceipt && data.dueDate && (
                <p className="text-xs text-gray-600">Due: {data.dueDate}</p>
              )}
              {isReceipt && data.paidDate && (
                <p className="text-xs text-gray-600">Paid: {data.paidDate}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 mb-6 text-sm">
            <div>
              <p className="font-bold text-gray-900 mb-2 text-xs uppercase tracking-wide">Seller</p>
              <p className="font-semibold text-gray-800">{data.seller.name}</p>
              {data.seller.address.map((line, i) => (
                <p key={i} className="text-gray-700">{line}</p>
              ))}
              <p className="text-gray-700 mt-1">GSTIN: {data.seller.gstin}</p>
              <p className="text-gray-700">PAN: {data.seller.pan}</p>
              <p className="text-gray-700">CIN: {data.seller.cin || 'N/A'}</p>
              <p className="text-gray-700">Email: {data.seller.email}</p>
              <p className="text-gray-700">Phone: {data.seller.phone}</p>
            </div>
            <div>
              <p className="font-bold text-gray-900 mb-2 text-xs uppercase tracking-wide">
                {isReceipt ? 'Paid By' : 'Buyer'}
              </p>
              <p className="font-semibold text-gray-800">{data.buyer.name}</p>
              {data.buyer.address.map((line, i) => (
                <p key={i} className="text-gray-700">{line}</p>
              ))}
              <p className="text-gray-700 mt-1">GSTIN: {data.buyer.gstin}</p>
              <p className="text-gray-700">State Code: {data.buyer.stateCode}</p>
              {isReceipt && data.paymentMethod && (
                <p className="text-gray-700 mt-1">Payment Mode: {data.paymentMethod}</p>
              )}
              {isReceipt && data.transactionId && (
                <p className="text-gray-700">Transaction ID: {data.transactionId}</p>
              )}
            </div>
          </div>

          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-y-2 border-gray-800 bg-gray-100">
                <th className="text-left py-2 px-2 font-bold text-gray-900">#</th>
                <th className="text-left py-2 px-2 font-bold text-gray-900">Description</th>
                <th className="text-left py-2 px-2 font-bold text-gray-900">SAC</th>
                <th className="text-right py-2 px-2 font-bold text-gray-900">Qty</th>
                <th className="text-right py-2 px-2 font-bold text-gray-900">Rate (₹)</th>
                <th className="text-right py-2 px-2 font-bold text-gray-900">Taxable (₹)</th>
                <th className="text-right py-2 px-2 font-bold text-gray-900">CGST 9%</th>
                <th className="text-right py-2 px-2 font-bold text-gray-900">SGST 9%</th>
                <th className="text-right py-2 px-2 font-bold text-gray-900">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, i) => (
                <tr key={i} className="border-b border-gray-200">
                  <td className="py-2 px-2 text-gray-700">{i + 1}</td>
                  <td className="py-2 px-2 text-gray-700">{item.description}</td>
                  <td className="py-2 px-2 text-gray-600">{item.sac}</td>
                  <td className="py-2 px-2 text-right text-gray-700">{item.qty}</td>
                  <td className="py-2 px-2 text-right text-gray-700">{item.rate.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  <td className="py-2 px-2 text-right text-gray-700">{item.taxable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  <td className="py-2 px-2 text-right text-gray-700">{item.cgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  <td className="py-2 px-2 text-right text-gray-700">{item.sgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  <td className="py-2 px-2 text-right text-gray-800 font-semibold">{item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex justify-end mb-4">
            <div className="w-72 text-sm">
              <div className="flex justify-between py-1 text-gray-700">
                <span>Taxable Value</span>
                <span>₹{data.taxableTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between py-1 text-gray-700">
                <span>CGST (9%)</span>
                <span>₹{data.totalCgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between py-1 text-gray-700">
                <span>SGST (9%)</span>
                <span>₹{data.totalSgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between py-2 border-t-2 border-gray-800 font-bold text-gray-900 text-base">
                <span>Grand Total</span>
                <span>₹{data.grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">
            <p className="text-xs font-semibold text-gray-600 mb-0.5">Amount in Words</p>
            <p className="text-sm text-gray-800 font-medium">{data.amountWords}</p>
          </div>

          {isReceipt && (
            <div className="border-4 border-emerald-500 rounded-lg p-4 text-center mb-4">
              <p className="text-2xl font-black text-emerald-600 tracking-[0.4em]">PAID</p>
              <p className="text-sm text-gray-600 mt-1">Thank you for your business</p>
            </div>
          )}

          <div className="flex items-end justify-between mt-6">
            <div className="text-xs text-gray-500">
              <p>Computer-generated {isReceipt ? 'receipt' : 'invoice'}. No signature required.</p>
              <p>For queries: {data.seller.email}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-400 mb-6">Authorized Signatory</p>
              <div className="border-t border-gray-400 w-40 ml-auto pt-1">
                <p className="text-xs text-gray-500">For {data.seller.name}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Screen Preview */}
        <div className="no-print">
          {/* Title Banner */}
          <div className="bg-gray-50 border-b border-gray-200 px-6 py-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                {isReceipt ? 'Payment Receipt' : 'Tax Invoice — GST'}
              </p>
              <h3 className="text-lg font-bold text-gray-900">{data.seller.name}</h3>
            </div>
            <div className="text-right">
              <span className={`inline-block px-2.5 py-1 rounded-md text-[10px] font-bold tracking-wide border ${
                isReceipt
                  ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                  : 'bg-amber-50 text-amber-600 border-amber-200'
              }`}>
                {isReceipt ? 'PAID' : 'BILLED'}
              </span>
              <p className="text-xs text-gray-500 mt-1">{data.id}</p>
            </div>
          </div>

          <div className="p-6">
            {/* Party Details */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-2">Seller (From)</p>
                <p className="text-sm font-bold text-gray-900">{data.seller.name}</p>
                {data.seller.address.map((line, i) => (
                  <p key={i} className="text-xs text-gray-600">{line}</p>
                ))}
                <div className="mt-2 space-y-0.5">
                  <p className="text-xs text-gray-500">GSTIN: <span className="font-mono text-gray-700">{data.seller.gstin}</span></p>
                  <p className="text-xs text-gray-500">PAN: <span className="font-mono text-gray-700">{data.seller.pan}</span></p>
                  <p className="text-xs text-gray-500">Email: {data.seller.email}</p>
                  <p className="text-xs text-gray-500">Phone: {data.seller.phone}</p>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-2">
                  {isReceipt ? 'Paid By' : 'Buyer (To)'}
                </p>
                <p className="text-sm font-bold text-gray-900">{data.buyer.name}</p>
                {data.buyer.address.map((line, i) => (
                  <p key={i} className="text-xs text-gray-600">{line}</p>
                ))}
                <div className="mt-2 space-y-0.5">
                  <p className="text-xs text-gray-500">GSTIN: <span className="font-mono text-gray-700">{data.buyer.gstin}</span></p>
                  <p className="text-xs text-gray-500">State Code: {data.buyer.stateCode}</p>
                  {isReceipt && data.paymentMethod && (
                    <p className="text-xs text-gray-500">Paid Via: {data.paymentMethod}</p>
                  )}
                  {isReceipt && data.transactionId && (
                    <p className="text-xs text-gray-500">Txn ID: <span className="font-mono">{data.transactionId}</span></p>
                  )}
                </div>
              </div>
            </div>

            {/* Invoice Meta */}
            <div className="flex flex-wrap gap-4 mb-5 text-xs text-gray-500 bg-gray-50 rounded-lg border border-gray-200 p-3">
              <div>
                <span className="text-gray-400">Invoice Date:</span>{' '}
                <span className="font-medium text-gray-700">{data.date}</span>
              </div>
              {!isReceipt && data.dueDate && (
                <div>
                  <span className="text-gray-400">Due Date:</span>{' '}
                  <span className="font-medium text-gray-700">{data.dueDate}</span>
                </div>
              )}
              {isReceipt && data.paidDate && (
                <div>
                  <span className="text-gray-400">Paid On:</span>{' '}
                  <span className="font-medium text-emerald-600">{data.paidDate}</span>
                </div>
              )}
            </div>

            {/* Items Table */}
            <div className="border border-gray-200 rounded-lg overflow-hidden mb-5">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-gray-100 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-3 py-2.5 text-[11px] font-bold text-gray-700 w-8">#</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-bold text-gray-700">Description</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-bold text-gray-700 w-20">SAC</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-bold text-gray-700 w-14">Qty</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-bold text-gray-700 w-28">Rate</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-bold text-gray-700 w-28">Taxable</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-bold text-gray-700 w-24">CGST 9%</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-bold text-gray-700 w-24">SGST 9%</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-bold text-gray-700 w-28">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item, i) => (
                      <tr key={i} className="border-b border-gray-100 last:border-b-0">
                        <td className="px-3 py-2.5 text-gray-500 text-xs">{i + 1}</td>
                        <td className="px-3 py-2.5 text-gray-800 text-xs font-medium">{item.description}</td>
                        <td className="px-3 py-2.5 text-gray-500 text-xs font-mono">{item.sac}</td>
                        <td className="px-3 py-2.5 text-right text-gray-600 text-xs">{item.qty}</td>
                        <td className="px-3 py-2.5 text-right text-gray-600 text-xs">₹{item.rate.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2.5 text-right text-gray-600 text-xs">₹{item.taxable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2.5 text-right text-gray-600 text-xs">₹{item.cgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2.5 text-right text-gray-600 text-xs">₹{item.sgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2.5 text-right text-gray-900 text-xs font-bold">₹{item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Totals */}
            <div className="flex justify-end mb-5">
              <div className="w-full sm:w-80 bg-gray-50 rounded-lg border border-gray-200 p-4">
                <div className="flex justify-between text-xs text-gray-600 mb-1">
                  <span>Taxable Value</span>
                  <span className="font-mono">₹{data.taxableTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-xs text-gray-600 mb-1">
                  <span>CGST @ 9%</span>
                  <span className="font-mono">₹{data.totalCgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-xs text-gray-600 mb-2">
                  <span>SGST @ 9%</span>
                  <span className="font-mono">₹{data.totalSgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-sm font-bold text-gray-900 border-t border-gray-300 pt-2">
                  <span>Grand Total</span>
                  <span className="font-mono">₹{data.grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>

            {/* Amount in Words */}
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-3 mb-5">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">Amount in Words</p>
              <p className="text-sm text-gray-800 font-medium">{data.amountWords}</p>
            </div>

            {/* Paid Stamp */}
            {isReceipt && (
              <div className="flex justify-center mb-5">
                <div className="border-4 border-emerald-400 rounded-xl px-10 py-3 inline-block rotate-[-2deg]">
                  <p className="text-2xl font-black text-emerald-600 tracking-[0.4em]">PAID</p>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-3 pt-4 border-t border-gray-200">
              <div className="text-xs text-gray-400">
                <p>Computer-generated {isReceipt ? 'receipt' : 'invoice'}. No signature required.</p>
                <p className="mt-0.5">For queries: {data.seller.email}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400 mb-4">Authorized Signatory</p>
                <div className="border-t border-gray-300 w-36 ml-auto pt-1">
                  <p className="text-[10px] text-gray-500">For {data.seller.name}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}