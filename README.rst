Loupedeck Control
-----------------

- Setup: ``npm install``
- Run: ``./app.mjs``


Demo
----

.. raw:: html

    <div align="center">
    <img src="https://raw.githubusercontent.com/Determinant/loupedeck-ctrl/main/figures/main-page.jpg" width="70%">
    <img src="https://raw.githubusercontent.com/Determinant/loupedeck-ctrl/main/figures/ap-page.jpg" width="70%">
    </div>
 
Video: https://photos.app.goo.gl/1hAQ19DZQRo4RRr9A

Profile is currently in ``profile.yaml``.

Linux permission issue: copy ``50-loupedeck.rules`` to be under ``/etc/udev/rules.d`` and then ``sudo udevadm control --reload-rules && sudo udevadm trigger``.
