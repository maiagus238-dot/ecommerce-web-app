// controllers/orderController.js
// Controlador para gestionar pedidos en la tienda

const createOrder = async (req, res) => {
  try {
    const { userId, items, totalAmount, shippingAddress } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "El carrito está vacío." });
    }

    const newOrder = {
      orderId: Date.now(),
      userId,
      items,
      totalAmount,
      shippingAddress,
      status: "pending",
      createdAt: new Date()
    };

    return res.status(201).json({
      message: "Pedido creado exitosamente",
      order: newOrder
    });
  } catch (error) {
    return res.status(500).json({ error: "Error al procesar el pedido" });
  }
};

module.exports = { createOrder };
